import fs = require('fs');
import path = require('path');
import * as vscode from 'vscode';

export interface TcSuite {
	root_dir: string
	source_dir: string
	target: string
}

export interface OneTtcn3Suite {
	root_dir: string
	source_dir: string
	binary_dir: string
	target: string
}

interface Ttcn3SuiteType {
	source_dir: string
	binary_dir: string
	suites: TcSuite[]
}

export type Ws2Suite = Map<string, string>;

export function readTtcn3Suite(fileName: string): Ttcn3SuiteType {
	let content = fs.readFileSync(fileName, 'utf8');
	let obj: Ttcn3SuiteType = JSON.parse(content);
	return obj;
}

export function findTtcn3Suite(ws: readonly vscode.WorkspaceFolder[] | undefined): Ws2Suite {
	let p: string[] = [];
	const ws2suite: Ws2Suite = new Map<string, string>();
	ws?.forEach(element => {
		if (fs.existsSync(element.uri.fsPath)) {
			const file = path.join(element.uri.fsPath, 'build', 'ttcn3_suites.json');
			if (fs.existsSync(file)) {
				ws2suite.set(element.uri.fsPath, file);
			}
		}
	});
	return ws2suite;
}

