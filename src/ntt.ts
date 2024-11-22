import * as ttcn3_suites from "./ttcn3_suites";
import * as child_process from "child_process";
import * as fs from "fs";
import * as path from 'path';
import { OutputChannel, WorkspaceConfiguration } from 'vscode';

export interface Ttcn3Test {
	filename: string
	line: number
	column: number
	id: string
	tags?: string[]
}
export interface Ttcn3TestSuite {
	args: string[];
	name: string;
	version: string;
	description: string;
	author: string;
	license: string;
	homepage: string;
	repository: string;
	bugs: string;
	keywords: string[];
	sources: string[];
	imports: string[];
	before_build: string[];
	after_build: string[];
	before_run: string[];
	after_run: string[];
	before_test: string[];
	after_test: string[];
	variables: { [key: string]: string };
	diagnostics: string[];
	presets: { [key: string]: any };
	execute: string[];
	parameters_file: string;
	hooks_file: string;
	lint_file: string;
	manifest_file: string;
	root: string;
	source_dir: string;
	env_file: string;
	results_file: string;
	k3: {
		root: string;
		compiler: string;
		runtime: string;
		plugins: string[];
		includes: string[];
		clibdirs: string[];
		cincludes: string[];
		ossinfo: string;
		t3xf: string;
	};
	env: string[];
	files: string[];
}

export function discoverManifestFile(startPath: string): string | null {
	const fileName = 'package.yml'
	let currentPath = startPath;

	while (true) {
		const filePath = path.join(currentPath, fileName);
		if (fs.existsSync(filePath)) {
			return currentPath;
		}

		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) {
			// Reached the root directory
			break;
		}

		currentPath = parentPath;
	}

	return null;
}
export function getNttExeFromToolsPath(conf: WorkspaceConfiguration): string {
	let exe: string = "";
	let toolsPath: string[] | undefined = conf.get('server.toolsPath');
	if (toolsPath != undefined) {
		for (const p of toolsPath) {
			exe = path.join(p, 'ntt');
			if (fs.existsSync(exe)) {
				return exe;
			}
		}
	}
	return 'ntt'
}

interface TcTagsSeparator {
	tagName: string,
	tagSeparators: string
}

function splitterRegexFromConf(tagName: string, conf: WorkspaceConfiguration): RegExp | null {
	const tagsSettings: TcTagsSeparator[] | undefined = conf.get('test.tags');
	if ((tagsSettings !== null) || (tagsSettings !== undefined)) {
		for (const tv of tagsSettings!) {
			if (tagName === (tv.tagName + ':')) {
				return RegExp('[' + tv.tagSeparators + ']');
			}
		}
	}
	return null;
}

export function buildTagsList(conf: WorkspaceConfiguration, rawTags: string[]): string[] {
	let newTags: string[] = [];

	rawTags.forEach((rawTag: string) => {
		const colonIdx = rawTag.indexOf(':');

		let tagName = rawTag;
		if (colonIdx != -1) {
			tagName = rawTag.substring(0, colonIdx + 1);
			const tagValue = rawTag.substring(colonIdx + 1);
			const splitter = splitterRegexFromConf(tagName, conf);
			if (splitter != null) {
				const multiValues = tagValue.split(splitter);

				multiValues.forEach((v: string) => {
					v = v.trimStart();
					v = v.trimEnd();
					if (v.length > 0) {
						newTags.push(tagName.concat(v));
					}
				});
			} else {
				newTags.push(tagName.concat(tagValue))
			}
		}
		else {
			newTags.push(rawTag);
		}
	});
	return newTags;
}
export async function getTestcaseList(runInst: OutputChannel, exe: string, pathToYml: string): Promise<Ttcn3Test[]> {
	let tcList: Ttcn3Test[] = [];
	const child = child_process.spawn(exe, ['list', pathToYml, '--with-tags', '--json']);
	runInst.appendLine(`about to execute ${exe} list ${pathToYml} --with-tags --json`);
	child.on("error", (err: Error) => {
		stderrBuf = stderrBuf.concat(`Execution of ${exe} finished with: ${err}`);
	})
	let stdoutBuf = "";
	let stderrBuf = "";
	child.stdout.setEncoding('utf8'); // for text chunks
	child.stderr.setEncoding('utf8'); // for text chunks
	child.stdout.on('data', (chunk) => {
		// data from standard output is here as buffers
		stdoutBuf = stdoutBuf.concat(chunk);
	});

	child.stderr.on('data', (chunk) => {
		// data from standard error is here as buffers
		stderrBuf = stderrBuf.concat(chunk);
	});

	const exitCode = new Promise<string>((resolve, reject) => {
		child.on('close', (code) => {
			if (code == 0) {
				runInst.appendLine(`on closing pipe: code=${code}. Calling resolve passing ${stdoutBuf.length} bytes`);
				resolve(stdoutBuf);
			}
			else {
				runInst.appendLine(`on closing pipe: code=${code}. Calling reject passing ${stderrBuf}`)
				reject(stderrBuf);
			}
		});
	});

	// attention: without await we are not stopping here!
	await exitCode.then((buf: string) => {
		if (buf.length > 0) {
			tcList = JSON.parse(buf);
			runInst.appendLine(`after JSON parsing: tcList len: ${tcList.length}`);
		}
		if (stderrBuf.length > 0) {
			runInst.appendLine(`stderr of ${exe}: ${stderrBuf}`);
		}
	}, (reason) => {
		runInst.appendLine(`exec promise rejected: ${reason}`);
	});

	return new Promise<Ttcn3Test[]>((resolve) => {
		resolve(tcList);
	})
}

export async function show(runInst: OutputChannel, exe: string, pathToYml: string): Promise<Ttcn3TestSuite> {
	let testSuite: Ttcn3TestSuite;
	const child = child_process.spawn(exe, ['show', pathToYml, '--dumb', '--json']);
	runInst.appendLine(`about to execute ${exe} show ${pathToYml} --dumb --json`);
	child.on("error", (err: Error) => {
		stderrBuf = stderrBuf.concat(`Execution of '${exe} show' finished with: ${err}`);
	})
	let stdoutBuf = "";
	let stderrBuf = "";
	child.stdout.setEncoding('utf8'); // for text chunks
	child.stderr.setEncoding('utf8'); // for text chunks
	child.stdout.on('data', (chunk) => {
		// data from standard output is here as buffers
		stdoutBuf = stdoutBuf.concat(chunk);
	});

	child.stderr.on('data', (chunk) => {
		// data from standard error is here as buffers
		stderrBuf = stderrBuf.concat(chunk);
	});

	const exitCode = new Promise<string>((resolve, reject) => {
		child.on('close', (code) => {
			if (code == 0) {
				runInst.appendLine(`on closing pipe: code=${code}. Calling resolve passing ${stdoutBuf.length} bytes`);
				resolve(stdoutBuf);
			}
			else {
				runInst.appendLine(`on closing pipe: code=${code}. Calling reject passing ${stderrBuf}`)
				reject(stderrBuf);
			}
		});
	});

	// attention: without await we are not stopping here!
	await exitCode.then((buf: string) => {
		if (buf.length > 0) {
			testSuite = JSON.parse(buf);
			runInst.appendLine(`after JSON parsing: detected suite with name: ${testSuite.name}`);
		}
		if (stderrBuf.length > 0) {
			runInst.appendLine(`stderr of ${exe}: ${stderrBuf}`);
		}
	}, (reason) => {
		runInst.appendLine(`exec promise rejected: ${reason}`);
	});

	return new Promise<Ttcn3TestSuite>((resolve) => {
		resolve(testSuite);
	})
}