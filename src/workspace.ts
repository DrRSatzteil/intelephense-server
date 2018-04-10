/* 
 * Intelephense Server -- A PHP Language Server
 * Copyright (C) 2018  Ben Robert Mewburn <ben@mewburn.id.au>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 * 
 */
'use strict';

import * as fs from 'fs-extra';
import * as fg from 'fast-glob';
import * as path from 'path';
import { Log } from './log';
import * as micromatch from 'micromatch';
import { TextDocumentItem } from 'vscode-languageserver-types';

const VENDOR_TESTS_GLOB = '**/{test,tests,Test,Tests}/**';
const SLASH_DRIVE_PATTERN = /^\/[a-zA-Z]:/;
const DRIVE_PATTERN = /^[a-zA-Z]:/;

export interface FileInfo {
    uri: string;
    modified: number;
    size: number;
}

export interface Folder {
    uri: string;
    name: string;
}

interface FastGlobEntry extends fs.Stats {
    path: string;
    depth: number
}

interface Composer {
    require: { [name: string]: string };
    'require-dev': { [name: string]: string };
}

interface FileSystemProvider {
    readFile: (uri: string) => Promise<string | Buffer>;
    fileInfo: (uri: string) => Promise<FileInfo>;
}

function uriScheme(uri: string) {
    const colonPos = uri.indexOf(':');
    return colonPos > -1 ? uri.slice(0, colonPos) : '';
}

function schemeFileSystemProvider(scheme: string): FileSystemProvider {
    return scheme === 'file' ? LocalFileSystem : undefined;
}

/**
 * Only local file system supported
 */
export namespace Workspace {

    var folders: {[uri:string]:Folder} = {};

    export function addFolder(folder: Folder) {
        // make sure ends in /
        if (folder.uri[folder.uri.length - 1] !== '/') {
            folder.uri += '/';
        }

        folders[folder.uri] = folder;
    }

    export function removeFolder(folder: Folder) {
        if(folders[folder.uri]) {
            delete folders[folder.uri];
        }
    }

    export function findFiles(associations: string[], exclude: string[], useComposerJson: boolean) {
        return FileSearchProvider.findFiles(
            folderArray(),
            associations,
            exclude,
            useComposerJson
        );
    }

    export function filterFiles(files: string[], associations: string[], exclude: string[], useComposerJson: boolean) {
        return FileSearchProvider.filterFiles(
            files,
            folderArray(),
            associations,
            exclude,
            useComposerJson
        );
    }

    export function getDocument(uri: string) {
        const provider = schemeFileSystemProvider(uriScheme(uri));
        if (!provider) {
            return Promise.resolve<TextDocumentItem>(undefined);
        }

        return provider.readFile(
            uri
        ).then(data => {
            return <TextDocumentItem>{
                uri: uri,
                languageId: 'php',
                text: data.toString(),
                version: 0
            }
        }).catch(e => {
            if (e) {
                Log.warn(e.toString());
            }
            return undefined as TextDocumentItem;
        });
    }

    function folderArray() {
        return Object.keys(folders).map(k => {
            return folders[k];
        });
    }

}

namespace FileSearchProvider {

    export async function findFiles(folders: Folder[], associations: string[], exclude: string[], useComposerJson: boolean) {

        const allFiles:FileInfo[] = [];
        const vendorGuard = new Set<string>();
        for(let n = 0; n < folders.length; ++n) {
            Array.prototype.push.apply(
                allFiles, 
                await findFilesInFolder(folders[n].uri, associations, exclude, useComposerJson, vendorGuard)
            );
        }

        return allFiles;

    }

    export async function filterFiles(files: string[], folders: Folder[], associations: string[], exclude: string[], useComposerJson: boolean) {
        const allFiles:FileInfo[] = [];
        const vendorGuard = new Set<string>();
        for(let n = 0; n < folders.length; ++n) {
            Array.prototype.push.apply(
                allFiles, 
                await filterFilesInFolder(files, folders[n].uri, associations, exclude, useComposerJson, vendorGuard)
            );
        }

        return allFiles;
    }

    function isFileGlob(glob: string) {
        return glob.indexOf('/') < 0;
    }

    /**
     * converts an array of package names into globs relative to vendor directory
     * @param packages 
     * @param associations 
     * @param vendorGuard 
     */
    function vendorGlobs(packages: string[], associations: string[], vendorGuard: Set<string>) {

        const bracedFilePattern = '{' + associations.filter(isFileGlob).join(',') + '}';

        return packages.filter(v => {
            if (vendorGuard.has(v)) {
                return false;
            } else {
                vendorGuard.add(v);
                return true;
            }
        }).map(v => {
            return v + '/**/' + bracedFilePattern;
        });
    }

    /**
     * Returns a promise that resolves to an array of composer package names
     */
    function readComposerPackages(composerJsonUri: string) {

        const fileProvider = schemeFileSystemProvider(uriScheme(composerJsonUri));
        if(!fileProvider) {
            return Promise.resolve<string[]>([]);
        }

        return fileProvider.readFile(
            composerJsonUri
        ).then((data) => {

            try {
                const items: string[] = [];
                const composer = JSON.parse(data.toString()) as Composer;
                if (composer.require) {
                    Array.prototype.push.apply(items, Object.keys(composer.require));
                }

                if (composer["require-dev"]) {
                    Array.prototype.push.apply(items, Object.keys(composer["require-dev"]));
                }

                return items;

            } catch (e) {
                if (e) {
                    Log.warn(e.toString());
                }
                return <string[]>[];
            }

        }).catch((e) => {
            if (e && e.code !== 'ENOENT') {
                Log.warn(e.toString());
            }
            return <string[]>[];
        });

    }

    function findFilesInFolder(folderUri:string, associations:string[], exclude:string[], useComposerJson: boolean, vendorGuard: Set<string>) {

        if(uriScheme(folderUri) !== 'file') {
            return Promise.resolve<FileInfo[]>([]);
        }

        const files: FileInfo[] = [];
        const ignore = exclude.slice(0);
        const cwd = LocalFileSystem.uriToPath(this.uri);

        //do two passes
        //1. get vendor files
        //2. get src files, ignoring vendor
        let promise:Promise<FileInfo[]>;
        if(useComposerJson) {
            ignore.push('vendor/**');
            promise = readComposerPackages(
                folderUri + 'composer.json'
            ).then(packages => {

                if (packages.length < 1) {
                    return [];
                }
    
                return fg.async<FileInfo>(
                    vendorGlobs(packages, associations, vendorGuard),
                    {
                        stats: true,
                        cwd: path.join(cwd, 'vendor'),
                        ignore: [VENDOR_TESTS_GLOB],
                        transform: findFilesTransform
                    }
                ).catch(e => {
                    if (e) {
                        Log.warn(e.toString());
                    }
                    return [];
                });
    
            });
        } else {
            promise = Promise.resolve<FileInfo[]>([]);
        }

        return promise.then(vendorFiles => {
            Array.prototype.push.apply(files, vendorFiles);

            return fg.async<FileInfo>(
                associations,
                {
                    stats: true,
                    cwd: cwd,
                    ignore: ignore,
                    matchBase: true,
                    transform: findFilesTransform
                }
            ).catch(e => {
                if (e) {
                    Log.warn(e.toString());
                }
                return [];
            });

        }).then((srcFiles) => {
            Array.prototype.push.apply(files, srcFiles);
            return files;
        });

    }

    function findFilesTransform(entry: FastGlobEntry) {
        return <FileInfo>{
            uri: LocalFileSystem.pathToUri(entry.path),
            modified: entry.mtime.getTime(),
            size: entry.size
        };
    }

    /**
     * Filters a list of uris to those contained in folder and provides file info
     * @param uriArray 
     * @param vendorGuard 
     */
    function filterFilesInFolder(
        uriArray: string[], 
        folderUri: string, 
        associations: string[], 
        exclude: string[], 
        useComposerJson: boolean, 
        vendorGuard: Set<string>
    ) {

        const fileProvider = schemeFileSystemProvider(uriScheme(folderUri));

        if(!fileProvider) {
            return Promise.resolve<FileInfo[]>([]);
        }

        const globs = this.associations.map(x => {
            return isFileGlob(x) ? folderUri + '**/' + x : folderUri + x;
        });
        const ignore = useComposerJson ? folderUri + ['vendor/**'] : [];
        const matches = micromatch(uriArray, globs, { ignore: useComposerJson ? [folderUri + 'vendor/**'] : [] });
        let promise: Promise<string[]>;

        if(useComposerJson) {
            promise = readComposerPackages(
                folderUri + 'composer.json'
            ).then(packages => {
                const vGlobs = vendorGlobs(packages, associations, vendorGuard).map(x => {
                    return folderUri + 'vendor/' + x;
                });
    
                const vendorMatches = micromatch(uriArray, vGlobs, { ignore: [folderUri + 'vendor/' + VENDOR_TESTS_GLOB] });
                Array.prototype.push.apply(matches, vendorMatches);
                return matches;
            });

        } else {
            promise = Promise.resolve<string[]>(matches);
        }

        return promise.then(items => {

            const fileInfoArray:FileInfo[] = [];

            return new Promise<FileInfo[]>((resolve, reject) => {

                const onFileInfo = (i: FileInfo) => {
                    if (i) {
                        fileInfoArray.push(i);
                    }

                    if (items.length > 0) {
                        fileProvider.fileInfo(items.pop()).then(onFileInfo).catch(onFileInfo);
                    } else {
                        resolve(fileInfoArray);
                    }
                }

                onFileInfo(undefined);
            });

        });
    }

}

namespace LocalFileSystem {

    export function readFile(uri: string): Promise<string | Buffer> {
        return fs.readFile(
            uriToPath(uri)
        );
    }

    export function fileInfo(uri: string): Promise<FileInfo> {

        return fs.stat(
            uriToPath(uri)
        ).then(stats => {
            return <FileInfo>{
                uri: uri,
                modified: stats.mtime.getTime(),
                size: stats.size
            };
        }).catch(e => {
            if (e) {
                Log.warn(e.toString());
            }
            return undefined;
        });

    }

    export function pathToUri(filepath: string) {

        if (!filepath) {
            return '';
        }

        if (isWindows()) {
            filepath = filepath.replace(/\\/g, '/');
        }

        let uriAuth = '';
        let uriPath = '';

        if (filepath.length > 1 && filepath[0] === '/' && filepath[1] === '/') {
            //UNC path
            const i = filepath.indexOf('/', 2);
            if (i < 0) {
                uriAuth = filepath.slice(2);
                uriPath = '/';
            } else {
                uriAuth = filepath.slice(2, i);
                uriPath = filepath.slice(i);
                if (SLASH_DRIVE_PATTERN.test(uriPath)) {
                    uriPath = uriPath[0] + uriPath[1].toLowerCase() + uriPath.slice(2);
                }
            }

        } else if (filepath[0] === '/') {
            uriPath = filepath;
        } else if (DRIVE_PATTERN.test(filepath)) {
            uriPath = '/' + filepath[0].toLowerCase() + filepath.slice(1);
        } else {
            //relative path
            return '';
        }

        return encodeURI('file://' + uriAuth + uriPath);

    }

    export function uriToPath(uri: string) {

        let filepath = decodeURI(uri);

        if (filepath.slice(0, 7) !== 'file://' || filepath.length < 8) {
            return '';
        }

        filepath = filepath.slice(7);

        if (SLASH_DRIVE_PATTERN.test(filepath)) {
            filepath = filepath.slice(1);
        } else if (filepath[0] !== '/') {
            //UNC
            filepath = '//' + filepath;
        }

        if (isWindows()) {
            filepath = filepath.replace(/\//g, '\\');
        }

        return filepath;
    }

    function isWindows() {
        return process.platform === 'win32';
    }

}
