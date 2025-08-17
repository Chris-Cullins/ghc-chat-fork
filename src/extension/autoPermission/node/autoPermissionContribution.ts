/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAutoPermissionService } from '../../../platform/autoPermission/common/autoPermissionService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { AutoPermissionWebviewProvider } from '../webview/autoPermissionWebviewProvider';
import { AutoPermissionCommands } from './autoPermissionCommands';

export class AutoPermissionContribution extends Disposable implements IExtensionContribution {
	readonly id = 'autoPermissionContribution';
	private _webviewProvider: AutoPermissionWebviewProvider | undefined;
	private _commands: AutoPermissionCommands | undefined;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAutoPermissionService private readonly _autoPermissionService: IAutoPermissionService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		this._initialize();
	}

	private async _initialize(): Promise<void> {
		try {
			// Initialize built-in profiles
			await this._autoPermissionService.initializeBuiltInProfiles();

			// Register webview provider
			this._webviewProvider = this._instantiationService.createInstance(AutoPermissionWebviewProvider);
			this._register(vscode.window.registerWebviewViewProvider(
				'github.copilot.autoPermission',
				this._webviewProvider
			));

			// Register commands
			this._commands = this._instantiationService.createInstance(AutoPermissionCommands);
			this._register(this._commands);

			// Register context menu contributions
			this._registerContextMenus();

			this._logService.info('AutoPermissionContribution: Initialized successfully');
		} catch (error) {
			this._logService.error('AutoPermissionContribution: Failed to initialize', error);
		}
	}

	private _registerContextMenus(): void {
		// Context menu for file explorer
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.addFileRule', async (uri: vscode.Uri) => {
			if (this._commands) {
				await this._commands.addFileRule(uri);
			}
		}));

		// Context menu for editor
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.addCurrentFileRule', async () => {
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor && this._commands) {
				await this._commands.addFileRule(activeEditor.document.uri);
			}
		}));
	}
}