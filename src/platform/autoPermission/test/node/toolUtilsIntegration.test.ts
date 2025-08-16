/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as vscode from 'vscode';
import { DisposableStore, MutableDisposable } from '../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IIgnoreService } from '../../../ignore/common/ignoreService';
import { createPlatformServices } from '../../../test/node/services';
import { IWorkspaceService } from '../../../workspace/common/workspaceService';
import {
	IAutoPermissionService,
	PermissionDecision,
	PermissionOperation,
	PermissionScope,
	RiskLevel
} from '../../common/autoPermissionService';
import { AutoPermissionServiceImpl } from '../../node/autoPermissionServiceImpl';
import { assertFileOkForTool, assertFileOkForToolWithPermission } from '../../../tools/node/toolUtils';

suite('ToolUtils Integration with AutoPermission', () => {

	const scheme = 'permission-test';
	const uri1 = vscode.Uri.from({ scheme, path: '/allowed.txt' });
	const uri2 = vscode.Uri.from({ scheme, path: '/denied.exe' });
	const uri3 = vscode.Uri.from({ scheme, path: '/prompt.py' });
	const uri4 = vscode.Uri.from({ scheme, path: '/outside/workspace.txt' });

	const store = new DisposableStore();
	const fs = new MutableDisposable();
	let instaService: IInstantiationService;
	let autoPermissionService: IAutoPermissionService;
	let accessor: any;

	setup(async function () {
		const services = createPlatformServices();

		// Mock ignore service to avoid Copilot ignore conflicts
		services.define(IIgnoreService, {
			isCopilotIgnored: async () => false
		});

		accessor = services.createTestingAccessor();
		instaService = accessor.get(IInstantiationService);
		store.add(instaService);

		// Set up in-memory file system
		const memFs = new MemFS();
		fs.value = vscode.workspace.registerFileSystemProvider(scheme, memFs);
		memFs.writeFile(uri1, Buffer.from('Safe text file'), { create: true, overwrite: true });
		memFs.writeFile(uri2, Buffer.from('Executable file'), { create: true, overwrite: true });
		memFs.writeFile(uri3, Buffer.from('print("hello")'), { create: true, overwrite: true });
		memFs.writeFile(uri4, Buffer.from('Outside workspace'), { create: true, overwrite: true });

		// Initialize auto-permission service
		autoPermissionService = instaService.createInstance(AutoPermissionServiceImpl);
		store.add(autoPermissionService);
		services.define(IAutoPermissionService, autoPermissionService);

		// Create and activate test profile with rules
		const profileId = await autoPermissionService.createProfile({
			name: 'ToolUtils Test Profile',
			description: 'Profile for testing tool utils integration',
			isBuiltIn: false,
			isActive: false,
			isDefault: false,
			rules: [],
			defaultDecision: PermissionDecision.Prompt,
			securityLevel: 'custom'
		});

		// Add rules for testing
		await autoPermissionService.addRule(profileId, {
			name: 'Allow TXT Files',
			description: 'Allow reading text files',
			operation: PermissionOperation.Read,
			scope: PermissionScope.File,
			decision: PermissionDecision.Allow,
			riskLevel: RiskLevel.Low,
			conditions: [{
				type: 'fileExtension',
				operator: 'equals',
				value: 'txt'
			}],
			priority: 100,
			enabled: true,
			auditRequired: false
		});

		await autoPermissionService.addRule(profileId, {
			name: 'Deny EXE Files',
			description: 'Deny access to executable files',
			operation: PermissionOperation.Read,
			scope: PermissionScope.File,
			decision: PermissionDecision.Deny,
			riskLevel: RiskLevel.Critical,
			conditions: [{
				type: 'fileExtension',
				operator: 'equals',
				value: 'exe'
			}],
			priority: 200,
			enabled: true,
			auditRequired: true
		});

		await autoPermissionService.setActiveProfile(profileId);
	});

	teardown(async function () {
		store.clear();
		fs.clear();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('assertFileOkForTool should allow access when auto-permission allows', async function () {
		// Should not throw for allowed file
		await assertFileOkForTool(accessor, uri1, PermissionOperation.Read, 'test-tool');

		// Verify audit log
		const auditLog = autoPermissionService.getAuditLog(1);
		assert.strictEqual(auditLog.length, 1);
		assert.strictEqual(auditLog[0].result.decision, PermissionDecision.Allow);
		assert.strictEqual(auditLog[0].context.requestingTool, 'test-tool');
	});

	test('assertFileOkForTool should deny access when auto-permission denies', async function () {
		try {
			await assertFileOkForTool(accessor, uri2, PermissionOperation.Read, 'test-tool');
			assert.fail('Should have thrown error for denied file');
		} catch (error) {
			assert.ok(error.message.includes('denied by auto-permission policy'));
		}

		// Verify audit log
		const auditLog = autoPermissionService.getAuditLog(1);
		assert.strictEqual(auditLog.length, 1);
		assert.strictEqual(auditLog[0].result.decision, PermissionDecision.Deny);
	});

	test('assertFileOkForTool should allow prompt decisions by default', async function () {
		// Should not throw for prompt decision (falls back to allow)
		await assertFileOkForTool(accessor, uri3, PermissionOperation.Read, 'test-tool');

		// Verify audit log
		const auditLog = autoPermissionService.getAuditLog(1);
		assert.strictEqual(auditLog.length, 1);
		assert.strictEqual(auditLog[0].result.decision, PermissionDecision.Prompt);
	});

	test('assertFileOkForToolWithPermission should support skipAutoPermission option', async function () {
		// Should not check auto-permission when skipAutoPermission is true
		await assertFileOkForToolWithPermission(
			accessor,
			uri2,
			PermissionOperation.Read,
			'test-tool',
			{ skipAutoPermission: true }
		);

		// Should not have created audit log entry
		const auditLog = autoPermissionService.getAuditLog();
		const relevantEntries = auditLog.filter(entry =>
			entry.context.uri.toString() === uri2.toString()
		);
		assert.strictEqual(relevantEntries.length, 0);
	});

	test('assertFileOkForToolWithPermission should handle promptOnDeny option', async function () {
		try {
			await assertFileOkForToolWithPermission(
				accessor,
				uri2,
				PermissionOperation.Read,
				'test-tool',
				{ promptOnDeny: true }
			);
			assert.fail('Should still throw error even with promptOnDeny');
		} catch (error) {
			assert.ok(error.message.includes('denied by auto-permission policy'));
		}

		// Should have logged the denial
		const auditLog = autoPermissionService.getAuditLog(1);
		assert.strictEqual(auditLog[0].result.decision, PermissionDecision.Deny);
	});

	test('tool utils should fall back gracefully when auto-permission service unavailable', async function () {
		// Remove auto-permission service from accessor
		const mockAccessor = {
			get: (serviceId: any) => {
				if (serviceId === IAutoPermissionService) {
					throw new Error('No service of type IAutoPermissionService');
				}
				return accessor.get(serviceId);
			}
		};

		// Should not throw and should fall back to default behavior
		await assertFileOkForTool(mockAccessor, uri1, PermissionOperation.Read, 'test-tool');
		await assertFileOkForTool(mockAccessor, uri2, PermissionOperation.Read, 'test-tool');
	});

	test('tool utils should handle auto-permission service errors gracefully', async function () {
		// Mock auto-permission service that throws errors
		const faultyService = {
			evaluatePermission: async () => {
				throw new Error('Service temporarily unavailable');
			}
		};

		const mockAccessor = {
			get: (serviceId: any) => {
				if (serviceId === IAutoPermissionService) {
					return faultyService;
				}
				return accessor.get(serviceId);
			}
		};

		// Should not throw and should fall back to default behavior
		await assertFileOkForTool(mockAccessor, uri1, PermissionOperation.Read, 'test-tool');
	});

	test('tool utils should respect existing workspace and ignore checks', async function () {
		// Mock workspace service to return no workspace folder
		const mockWorkspaceService = {
			getWorkspaceFolder: () => undefined
		};

		// Mock tabs service to return no open tabs
		const mockTabsService = {
			tabs: []
		};

		const mockAccessor = {
			get: (serviceId: any) => {
				if (serviceId === IWorkspaceService) {
					return mockWorkspaceService;
				}
				if (serviceId.toString().includes('TabsAndEditorsService')) {
					return mockTabsService;
				}
				return accessor.get(serviceId);
			}
		};

		try {
			await assertFileOkForTool(mockAccessor, uri4, PermissionOperation.Read, 'test-tool');
			assert.fail('Should have thrown error for file outside workspace');
		} catch (error) {
			assert.ok(error.message.includes('outside of the workspace'));
		}
	});

	test('different operations should be evaluated correctly', async function () {
		// Test write operation (should use prompt default)
		await assertFileOkForTool(accessor, uri3, PermissionOperation.Write, 'write-tool');

		let auditLog = autoPermissionService.getAuditLog(1);
		assert.strictEqual(auditLog[0].context.operation, PermissionOperation.Write);
		assert.strictEqual(auditLog[0].result.decision, PermissionDecision.Prompt);

		// Test read operation (should match allow rule)
		await assertFileOkForTool(accessor, uri1, PermissionOperation.Read, 'read-tool');

		auditLog = autoPermissionService.getAuditLog(1);
		assert.strictEqual(auditLog[0].context.operation, PermissionOperation.Read);
		assert.strictEqual(auditLog[0].result.decision, PermissionDecision.Allow);
	});

	test('should handle batch operations correctly', async function () {
		const files = [uri1, uri3]; // One allow, one prompt

		for (const file of files) {
			await assertFileOkForTool(accessor, file, PermissionOperation.Read, 'batch-tool');
		}

		const auditLog = autoPermissionService.getAuditLog(2);
		assert.strictEqual(auditLog.length, 2);

		// Should have one allow and one prompt decision
		const decisions = auditLog.map(entry => entry.result.decision);
		assert.ok(decisions.includes(PermissionDecision.Allow));
		assert.ok(decisions.includes(PermissionDecision.Prompt));
	});

	test('should log requesting tool correctly in audit', async function () {
		const toolName = 'specific-test-tool';

		await assertFileOkForTool(accessor, uri1, PermissionOperation.Read, toolName);

		const auditLog = autoPermissionService.getAuditLog(1);
		assert.strictEqual(auditLog[0].context.requestingTool, toolName);
	});

	test('should determine scope correctly based on workspace', async function () {
		await assertFileOkForTool(accessor, uri1, PermissionOperation.Read, 'scope-tool');

		const auditLog = autoPermissionService.getAuditLog(1);
		// Since we're using a custom scheme, it should be detected as system scope
		assert.strictEqual(auditLog[0].context.scope, PermissionScope.System);
	});

});

// Minimal file system implementation for testing
class File implements vscode.FileStat {
	type: vscode.FileType;
	ctime: number;
	mtime: number;
	size: number;
	name: string;
	data?: Uint8Array;

	constructor(name: string) {
		this.type = vscode.FileType.File;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
	}
}

class Directory implements vscode.FileStat {
	type: vscode.FileType;
	ctime: number;
	mtime: number;
	size: number;
	name: string;
	entries: Map<string, File | Directory>;

	constructor(name: string) {
		this.type = vscode.FileType.Directory;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.entries = new Map();
	}
}

class MemFS implements vscode.FileSystemProvider {
	root = new Directory('');

	stat(uri: vscode.Uri): vscode.FileStat {
		return this._lookup(uri, false);
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		const entry = this._lookupAsDirectory(uri, false);
		const result: [string, vscode.FileType][] = [];
		for (const [name, child] of entry.entries) {
			result.push([name, child.type]);
		}
		return result;
	}

	readFile(uri: vscode.Uri): Uint8Array {
		const data = this._lookupAsFile(uri, false).data;
		if (data) {
			return data;
		}
		throw vscode.FileSystemError.FileNotFound();
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
		const basename = path.posix.basename(uri.path);
		const parent = this._lookupParentDirectory(uri);
		let entry = parent.entries.get(basename);
		if (entry instanceof Directory) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (!entry && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (entry && options.create && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		if (!entry) {
			entry = new File(basename);
			parent.entries.set(basename, entry);
		}
		entry.mtime = Date.now();
		entry.size = content.byteLength;
		entry.data = content;
	}

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
		// Not needed for tests
	}

	delete(uri: vscode.Uri): void {
		// Not needed for tests
	}

	createDirectory(uri: vscode.Uri): void {
		// Not needed for tests
	}

	private _lookup(uri: vscode.Uri, silent: boolean): File | Directory | undefined {
		const parts = uri.path.split('/');
		let entry: File | Directory = this.root;
		for (const part of parts) {
			if (!part) {
				continue;
			}
			let child: File | Directory | undefined;
			if (entry instanceof Directory) {
				child = entry.entries.get(part);
			}
			if (!child) {
				if (!silent) {
					throw vscode.FileSystemError.FileNotFound(uri);
				} else {
					return undefined;
				}
			}
			entry = child;
		}
		return entry;
	}

	private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
		const entry = this._lookup(uri, silent);
		if (entry instanceof Directory) {
			return entry;
		}
		throw vscode.FileSystemError.FileNotADirectory(uri);
	}

	private _lookupAsFile(uri: vscode.Uri, silent: boolean): File {
		const entry = this._lookup(uri, silent);
		if (entry instanceof File) {
			return entry;
		}
		throw vscode.FileSystemError.FileIsADirectory(uri);
	}

	private _lookupParentDirectory(uri: vscode.Uri): Directory {
		const dirname = uri.with({ path: path.posix.dirname(uri.path) });
		return this._lookupAsDirectory(dirname, false);
	}

	// Event handling (minimal implementation)
	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}
}