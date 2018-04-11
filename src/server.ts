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

import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind, RequestType, TextDocumentItem,
	PublishDiagnosticsParams, SignatureHelp, DidChangeConfigurationParams,
	Position, TextEdit, Disposable, DocumentRangeFormattingRequest,
	DocumentFormattingRequest, DocumentSelector, TextDocumentIdentifier,
	CancellationToken, CancellationTokenSource, FileChangeType, FileEvent, MessageActionItem, WorkspaceFolder
} from 'vscode-languageserver';
import { Intelephense, IntelephenseConfig, InitialisationOptions, LanguageRange } from 'intelephense';
import { Workspace, FileInfo } from './workspace';
import {Cache} from './cache';
import {Log} from './log';
import * as os from 'os';

const PHP_LANGUAGE_ID = 'php';
const importSymbolRequest = new RequestType<{ uri: string, position: Position, alias?: string }, TextEdit[], void, void>('importSymbol');
const documentLanguageRangesRequest = new RequestType<{ textDocument: TextDocumentIdentifier }, { version: number, ranges: LanguageRange[] }, void, void>('documentLanguageRanges');


// Create a connection for the server. 
// Transport should default to cmd line flags
let connection: IConnection = createConnection();
let initializeParams: InitializeParams;
let docFormatRegister: Thenable<Disposable>;
let config: ServerConfig;
let storagePath = os.tmpdir();

Log.connection = connection;

// Initialise 
connection.onInitialize((params) => {

	initializeParams = params;
	Log.info('Initialising');

	let initialiseStart = process.hrtime();

	//fallback list for open folders
	if (params.workspaceFolders) {
		params.workspaceFolders.forEach(f => {
			Workspace.addFolder(f);
		});
	} else if (params.rootUri) {
		Workspace.addFolder({uri: params.rootUri, name: params.rootUri});
	}

	if(params.initializationOptions && params.initializationOptions.storagePath) {
		storagePath = params.initializationOptions.storagePath
	} 

	let cachePromise:Promise<Cache>;
	if(
		(!params.initializationOptions || !params.initializationOptions.clearCache) &&
		Workspace.hasFolders()
	) {
		cachePromise = Cache.create(cacheDir(Workspace.folderArray()));
	} else {
		cachePromise = Promise.resolve(undefined);
	}

	return cachePromise.then(c => {
		return Intelephense.initialise({
			logger:Log,
			cache:c
		});
	}).then(() => {

		Log.info(`Initialised in ${elapsed(initialiseStart).toFixed()} ms`);

		return <InitializeResult>{
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
				documentSymbolProvider: true,
				workspaceSymbolProvider: true,
				completionProvider: {
					triggerCharacters: [
						//php
						'$', '>', ':', '\\',
						// html/js
						// registered to enable request forwarding in vscode client
						'.', '<', '/'
					]
				},
				signatureHelpProvider: {
					triggerCharacters: ['(', ',']
				},
				definitionProvider: true,
				documentRangeFormattingProvider: false,
				referencesProvider: true,
				hoverProvider: true,
				documentHighlightProvider: true,
				// not implemented but registered to intercept calls in vscode client middleware
				documentLinkProvider: { resolveProvider: false }
			}
		}
	});

});

// initialised sent once after the client has recceived intialise response
// and before any other requests
// do setup and workspace indexing here
connection.onInitialized(() => {

	//register notify diagnostics 
	Intelephense.onPublishDiagnostics((args) => {
		connection.sendDiagnostics(args);
	});

	//fetch config
	connection.workspace.getConfiguration(
		'intelephense'
	).then((settings: ServerConfig) => {

		if (!settings) {
			Log.warn('Failed to get configuration from client.');
		} else {
			config = settings;
			//set intelephese config

		}

		//dynamically register format provider
		if (getConfigValue('formatProvider.enable', true)) {
			let documentSelector: DocumentSelector = [{ language: PHP_LANGUAGE_ID, scheme: 'file' }];
			if (!docFormatRegister) {
				docFormatRegister = connection.client.register(DocumentRangeFormattingRequest.type, { documentSelector });
			}
		}

		//index workspace
		Indexer.indexWorkspace();

	});

});

connection.onDidChangeConfiguration((params) => {

	let settings = params.settings.intelephense as ServerConfig;
	if (!settings) {
		return;
	}
	config = settings;
	Intelephense.setConfig(config);

	let enableFormatter = config.formatProvider && config.formatProvider.enable;
	if (enableFormatter) {
		let documentSelector: DocumentSelector = [{ language: PHP_LANGUAGE_ID, scheme: 'file' }];
		if (!docFormatRegister) {
			docFormatRegister = connection.client.register(DocumentRangeFormattingRequest.type, { documentSelector });
		}
	} else {
		if (docFormatRegister) {
			docFormatRegister.then(r => r.dispose());
			docFormatRegister = null;
		}
	}

});

//For now registered to intercept requests in vscode client
connection.onDocumentLinks((params) => {
	return [];
});

connection.onHover((params) => {
	return Intelephense.provideHover(params.textDocument.uri, params.position);
});

connection.onDocumentHighlight((params) => {
	return Intelephense.provideHighlights(params.textDocument.uri, params.position);
})

connection.onDidOpenTextDocument((params) => {

	// assume ascii when checking file size
	if (params.textDocument.text.length > getConfigValue('files.maxSize', 1000000)) {
		Log.warn(`${params.textDocument.uri} not opened -- over max file size.`);
		return;
	}

	if (params.textDocument.languageId !== PHP_LANGUAGE_ID) {
		return;
	}

	Intelephense.openDocument(params.textDocument);
});

connection.onDidChangeTextDocument((params) => {
	Intelephense.editDocument(params.textDocument, params.contentChanges);
});

connection.onDidCloseTextDocument((params) => {
	Intelephense.closeDocument(params.textDocument);
});

connection.onDocumentSymbol((params) => {
	return Intelephense.documentSymbols(params.textDocument);
});

connection.onWorkspaceSymbol((params) => {
	return Intelephense.workspaceSymbols(params.query);
});

connection.onReferences((params) => {
	return Intelephense.provideReferences(params.textDocument, params.position, params.context);
});

connection.onCompletion((params) => {
	return Intelephense.provideCompletions(params.textDocument, params.position);
});

connection.onSignatureHelp((params) => {
	return Intelephense.provideSignatureHelp(params.textDocument, params.position);
});

connection.onDefinition((params) => {
	return Intelephense.provideDefinition(params.textDocument, params.position);
});

connection.onDocumentRangeFormatting((params) => {
	return Intelephense.provideDocumentRangeFormattingEdits(params.textDocument, params.range, params.options);
});

connection.onShutdown(Intelephense.shutdown);

connection.onDidChangeWatchedFiles((params) => {
	
	// batch these because files that are to be indexed
	// are first confirmed to be in a folder which
	// involves reading composer.json
	const toForget:string[] = [];
	const toIndex:string[] = [];
	let e:FileEvent

	for(let n = 0, l = params.changes.length; n < l; ++n) {
		e = params.changes[n];
		if(e.type === FileChangeType.Deleted) {
			toForget.push(e.uri);
		} else {
			toIndex.push(e.uri);
		}
	}

	Indexer.forgetFiles(toForget);
	Indexer.indexFiles(toIndex);

});

connection.workspace.onDidChangeWorkspaceFolders((params) => {
	params.added.forEach(f => {
		Workspace.addFolder(f);
	})

	params.removed.forEach(f => {
		Workspace.removeFolder(f);
	});	

	Indexer.indexWorkspace(true);
});

connection.onRequest(importSymbolRequest, (params) => {
	return Intelephense.provideContractFqnTextEdits(params.uri, params.position, params.alias);
});

connection.onRequest(documentLanguageRangesRequest, (params) => {
	return Intelephense.documentLanguageRanges(params.textDocument);
});

// Listen on the connection
connection.listen();

/**
 * elapsed time in ms
 * @param start 
 */
function elapsed(start: [number, number]) {
	if (!start) {
		return 0;
	}
	let diff = process.hrtime(start);
	return diff[0] * 1000 + diff[1] / 1000000;
}

function getConfigValue<T>(key: string, defaultValue: T): T {

	const chain = key.split('.');
	let prop: string;
	let val: any = config;

	while ((prop = chain.shift()) && val !== undefined) {
		val = val[prop];
	}

	return val !== undefined ? val : defaultValue;
}

function cacheDir(folders:WorkspaceFolder[]) {
	let concat = folders.reduce((last, current) => {
		return last + current.uri;
	}, '');
	return Math.abs(hash32(concat)).toString(16);
}

function hash32(text: string) {
    let hash = 0;
    let chr: number;
    for (let i = 0, l = text.length; i < l; ++i) {
        chr = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

interface IndexResult {
	totalFileCount: number;
	indexedFileCount: number;
	forgottenFileCount: number;
	symbolCount:number;
	elapsed: number;
	wasCancelled?: boolean;
}

namespace Indexer {

	var indexing: CancellationTokenSource;

	export function isIndexing() {
		return indexing !== undefined;
	}

	export async function indexWorkspace(restartIfInProgress?: boolean) {

		const result: IndexResult = {
			totalFileCount: 0,
			indexedFileCount: 0,
			forgottenFileCount: 0,
			symbolCount: 0,
			elapsed: 0
		}

		const start = process.hrtime();

		if (indexing) {
			if (!restartIfInProgress) {
				result.wasCancelled = true;
				return result;
			} else {
				cancelIndexing();
			}
		}

		indexing = new CancellationTokenSource();
		const token = indexing.token;
		const knownDocs = Intelephense.knownDocuments();
		const known: Set<string> = new Set(knownDocs.documents);
		const timestamp = knownDocs.timestamp;
		const maxFileSize = getConfigValue('files.maxSize', 1000000);
		const associations = getConfigValue('files.associations', []);
		associations.push('*.php');

		const files = await Workspace.findFiles(
			Array.from(new Set(associations)),
			getConfigValue('files.exclude', []),
			getConfigValue('indexer.useComposerJson', true)
		);

		let file:FileInfo;
		let doc:TextDocumentItem;
		for (let n = 0, l = files.length; n < l && !token.isCancellationRequested; ++n) {
			
			file = files[n];
			if (known.has(file.uri)) {
				known.delete(file.uri);
				if (file.modified < timestamp) {
					continue;
				}
			} else if (file.size > maxFileSize) {
				Log.warn(`${file.uri} not opened -- over max file size.`);
				continue;
			}

			doc = await Workspace.getDocument(file.uri);
			if (doc) {
				result.indexedFileCount++;
				result.symbolCount += await discover(doc);
			}
		}

		result.forgottenFileCount = known.size;
		if (!token.isCancellationRequested && result.forgottenFileCount > 0) {
			await forgetFiles(Array.from(known));
		}

		if(token.isCancellationRequested) {
			result.wasCancelled = true;
		}
		result.elapsed = elapsed(start) / 1000;
		return result;

	}

	export function cancelIndexing() {
		if (!indexing) {
			return;
		}

		indexing.cancel();
		indexing.dispose();
		indexing = undefined;
	}

	/**
	 * files are first filtered to ensure they are part of workspace
	 * @param uriArray 
	 */
	export async function indexFiles(uriArray: string[]) {
		
		const maxFileSize = getConfigValue('files.maxSize', 1000000);
		const files = await Workspace.filterFiles(
			uriArray,
			getConfigValue('files.associations', ['*.php']),
			getConfigValue('files.exclude', []),
			getConfigValue('indexer.useComposerJson', true)
		);

		let file:FileInfo;
		let doc: TextDocumentItem;
		for(let n = 0, l = files.length; n < l; ++n) {
			file = files[n];
			if(file.size <= maxFileSize) {
				doc = await Workspace.getDocument(file.uri);
				await discover(doc);
			}

		}
	}

	export async function forgetFiles(uriArray: string[]) {
		for (let n = 0; n < uriArray.length; ++n) {
			await forget(uriArray[n]);
		}
	}

	function forget(uri: string) {
		return new Promise<void>((resolve, reject) => {
			const fn = () => {
				Intelephense.forget(uri);
				resolve();
			}
			setImmediate(fn);
		});
	}

	function discover(doc: TextDocumentItem) {
		return new Promise<number>((resolve, reject) => {
			const fn = () => {
				const n = Intelephense.discoverSymbols(doc);
				resolve(n);
			}
			setImmediate(fn);
		});
	}

}

interface ServerConfig {
	formatProvider: {
		enable: boolean
	},
	files: {
		associations: string[],
		exclude: string[],

	}
}
