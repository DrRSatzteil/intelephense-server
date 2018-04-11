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
import * as path from 'path';
import { Log } from './log';
import * as jsonstream from 'JSONStream';

export class Cache {

    /**
     * 
     * @param dir must exist
     */
    constructor(private dir: string) { }

    put(key: string, data: any[]) {

        const file = this.pathFromKey(key);

        return new Promise<void>((resolve, reject) => {

            const transformStream = jsonstream.stringify('[', ',', ']');
            const writeStream = fs.createWriteStream(file);
    
            transformStream.on('error', (err:any) => {
                Log.error(err.toString());
                reject(err.message);
            });

            writeStream.on('finish', () => {
                resolve();
            }).on('error', (err:any) => {
                Log.error(err.toString());
                reject(err.message);
            });
        
            transformStream.pipe(writeStream);
        
            for(let n = 0, l = data.length; n < l; ++n) {
                transformStream.write(data[n]);
            }

            transformStream.end();
        });

    }

    get(key: string, useStream:boolean): Promise<any[]> {

        const file = this.pathFromKey(key);

        return new Promise<any[]>((resolve, reject) => {
            
            const transformStream = jsonstream.parse('*');
            const readStream = fs.createReadStream(file);
            const items: any[] = [];
    
            readStream.on('error', (err:any)=>{
                if (err && err.code !== 'ENOENT') {
                    Log.error(err.toString());
                    reject(err);
                } else {
                    resolve(items);
                }
            });
    
            readStream.pipe(transformStream).on('data', (item:any) => {
                items.push(item);
            }).on('end', () => {
                resolve(items);
            }).on('error', (err:any) => {
                Log.error(err.message);
                reject(err.message);
            });
        });
    }

    del(key: string) {
        return fs.unlink(this.pathFromKey(key));
    }

    dispose() {
        return fs.remove(this.pathFromKey(this.dir))
    }

    private pathFromKey(key:string) {
        return path.join(this.dir, key + '.json');
    }

    static create(path: string): Promise<Cache> {
        return fs.ensureDir(
            path
        ).then(() => {
            return new Cache(path);
        }).catch(e => {
            if (e) {
                Log.warn(e.toString());
            }
            return undefined;
        });
    }

}