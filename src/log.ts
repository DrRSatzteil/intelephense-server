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

import {IConnection} from 'vscode-languageserver'

export namespace Log {

    export var connection:IConnection;

    export function info(msg:string) {
        if(!connection) {
            return;
        }
        connection.console.info(msg);
    }

    export function warn(msg:string) {
        if(!connection) {
            return;
        }
        connection.console.warn(msg);
    }

    export function error(msg:string) {
        if(!connection) {
            return;
        }
        connection.console.error(msg);
    }
}