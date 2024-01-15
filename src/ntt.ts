import * as ttcn3_suites from "./ttcn3_suites";
import * as child_process from "child_process";
import { OutputChannel } from 'vscode';

export interface Ttcn3Test {
	filename: string
	line: number
	column: number
	id: string
	tags: string[]
}

export function buildTagsList(rawTags: string[]): string[] {
	let newTags: string[] = [];
	rawTags.forEach((rawTag: string) => {
		const colonIdx = rawTag.indexOf(':');

		let tagName = rawTag;
		if (colonIdx != -1) {
			tagName = rawTag.substring(0, colonIdx + 1);
			const tagValue = rawTag.substring(colonIdx + 1);
			const multiValues = tagValue.split(',');

			multiValues.forEach((v: string) => {
				v = v.trimStart();
				newTags.push(tagName.concat(v));
			});
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
