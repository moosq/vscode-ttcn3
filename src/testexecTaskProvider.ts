import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as ttcn3_suites from './ttcn3_suites';
import * as vscode from 'vscode';
import { error } from 'console';
import { openStdin } from 'process';

export class TestExecTaskProvider implements vscode.TaskProvider {
	static TestExecType = 'exec_ttcn3';
	private testExecPromise: Thenable<vscode.Task[]> | undefined = undefined;
	private suites: ttcn3_suites.Ttcn3SuiteType[];
	constructor(_suites: ttcn3_suites.Ttcn3SuiteType[]) {
		this.suites = _suites;
		/*const pattern = path.join(workspaceRoot, 'Rakefile');
		const fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
		fileWatcher.onDidChange(() => this.testExecPromise = undefined);
		fileWatcher.onDidCreate(() => this.testExecPromise = undefined);
		fileWatcher.onDidDelete(() => this.testExecPromise = undefined);*/
	}

	public provideTasks(): Thenable<vscode.Task[]> | undefined {
		if (!this.testExecPromise) {
			this.testExecPromise = this.getTestExecTasks();
		}
		return this.testExecPromise;
	}

	public resolveTask(_task: vscode.Task): vscode.Task | undefined {
		const task = _task.definition.task;
		// A Rake task consists of a task and an optional file as specified in TestExecTaskDefinition
		// Make sure that this looks like a Rake task by checking that there is a task.
		if (task) {
			// resolveTask requires that the same definition object be used.
			const definition: TestExecTaskDefinition = <any>_task.definition;
			const myPath = definition.myoptions?.env ? definition.myoptions?.env['PATH'] : "not supplied";
			getOutputChannel().appendLine(`resoveTask: ${task}, ${definition.mycommand}, ${definition.myargs}, name: ${definition.task}, ${myPath}`);
			getOutputChannel().show(true);

			return new vscode.Task(definition,
				_task.scope ?? vscode.TaskScope.Workspace,
				definition.task, TestExecTaskProvider.TestExecType,
				new vscode.ShellExecution(`${definition.mycommand} ${definition.myargs?.join(" ")}`, definition.myoptions));
		}
		return undefined;
	}

	private async getTestExecTasks(): Promise<vscode.Task[]> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const result: vscode.Task[] = [];
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return result;
		}

		getOutputChannel().appendLine('traverse detected suites');
		getOutputChannel().show(true);

		this.suites.forEach((suite, idx) => {
			for (const s of suite.suites) {
				const taskName = s.target; // NOTE: we might find a better name for this
				const myEnv = {
					'NTT_CACHE': "",
					'PYTHONUSERBASE': "",
					'PATH': process.env['PATH'] ? process.env['PATH'] : ""
				};
				const kind: TestExecTaskDefinition = {
					type: TestExecTaskProvider.TestExecType,
					task: taskName,
					mycommand: "k3s",
					//myargs: ["--debug", "-j3", "--control-sock=ctrl.sock"],
					myoptions: {
						cwd: "build",
						env: myEnv
					}
				};
				const task = new vscode.Task(kind, workspaceFolders[idx], taskName, TestExecTaskProvider.TestExecType, new vscode.ShellExecution(`${kind.mycommand} ${kind.myargs?.join(" ")} ${s.root_dir}`, kind.myoptions));
				result.push(task);
				task.group = vscode.TaskGroup.Test;
			}
		});

		getOutputChannel().appendLine('Auto detecting test execution tasks finished.');
		getOutputChannel().show(true);
		return result;
	}
}


function exec(command: string, options: cp.ExecOptions): Promise<{ stdout: string; stderr: string }> {
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		cp.exec(command, options, (error, stdout, stderr) => {
			if (error) {
				reject({ error, stdout, stderr });
			}
			resolve({ stdout, stderr });
		});
	});
}

let _channel: vscode.OutputChannel;
function getOutputChannel(): vscode.OutputChannel {
	if (!_channel) {
		_channel = vscode.window.createOutputChannel('ttcn3 Test Execution Auto Detection');
	}
	return _channel;
}

interface TestExecTaskDefinition extends vscode.TaskDefinition {
	/**
	 * The task name
	 */
	task: string;

	/**
	 * The command executing the tests
	 */
	mycommand: string;

	myargs?: string[];

	myoptions?: {
		cwd: string; //"cwd" needs to be present in the config(tasks.json) for the task being correctly recognized
		env?: { [key: string]: string }; // "env" doesn't need to be present in the config for the task being correctly recognized
	}
}

const buildNames: string[] = ['build', 'compile', 'watch'];
function isBuildTask(name: string): boolean {
	for (const buildName of buildNames) {
		if (name.indexOf(buildName) !== -1) {
			return true;
		}
	}
	return false;
}

const testNames: string[] = ['test'];
function isTestTask(name: string): boolean {
	for (const testName of testNames) {
		if (name.indexOf(testName) !== -1) {
			return true;
		}
	}
	return false;
}

