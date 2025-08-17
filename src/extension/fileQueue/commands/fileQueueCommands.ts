/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFileQueueService } from '../../../platform/fileQueue/common/fileQueueService';
import { ILogService } from '../../../platform/log/common/logService';

/**
 * Utility functions and command implementations for file queue operations
 */
export class FileQueueCommands {
	constructor(
		private readonly fileQueueService: IFileQueueService,
		private readonly logService: ILogService
	) { }

	/**
	 * Add files to the queue
	 */
	async addFiles(fileUris?: vscode.Uri[]): Promise<void> {
		try {
			// Get file URIs if not provided
			if (!fileUris || fileUris.length === 0) {
				const selectedFiles = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: true,
					title: 'Select files to add to processing queue'
				});

				if (!selectedFiles || selectedFiles.length === 0) {
					return;
				}

				fileUris = selectedFiles;
			}

			// Add files to queue
			const filePaths = fileUris.map(uri => uri.fsPath);
			const itemIds = await this.fileQueueService.addMultipleToQueue(
				filePaths
			);

			vscode.window.showInformationMessage(
				`Added ${itemIds.length} file${itemIds.length !== 1 ? 's' : ''} to queue`
			);

			this.logService.debug(`Added ${itemIds.length} files to queue`);
		} catch (error) {
			this.logService.error('Failed to add files:', error);
			vscode.window.showErrorMessage(`Failed to add files to queue: ${error}`);
		}
	}

	/**
	 * Add files from workspace folders
	 */
	async addFromWorkspace(): Promise<void> {
		try {
			if (!vscode.workspace.workspaceFolders) {
				vscode.window.showWarningMessage('No workspace folders are open');
				return;
			}

			// Get all files in workspace
			const fileUris = await vscode.workspace.findFiles(
				'**/*',
				'**/node_modules/**'
			);

			if (fileUris.length === 0) {
				vscode.window.showInformationMessage('No files found in workspace');
				return;
			}

			// Show file picker
			const fileItems = fileUris.map(uri => ({
				label: vscode.workspace.asRelativePath(uri),
				description: uri.fsPath,
				uri
			}));

			const selectedItems = await vscode.window.showQuickPick(fileItems, {
				placeHolder: 'Select files to add to queue',
				canPickMany: true,
				matchOnDescription: true
			});

			if (!selectedItems || selectedItems.length === 0) {
				return;
			}

			const selectedUris = selectedItems.map(item => item.uri);
			await this.addFiles(selectedUris);
		} catch (error) {
			this.logService.error('Failed to add files from workspace:', error);
			vscode.window.showErrorMessage(`Failed to add files from workspace: ${error}`);
		}
	}

	/**
	 * Start processing queue items
	 */
	async startProcessing(): Promise<void> {
		try {
			const queueItems = this.fileQueueService.getQueueItems();

			if (queueItems.length === 0) {
				vscode.window.showInformationMessage('No files in queue to process');
				return;
			}

			// Start processing for file content injection
			await this.fileQueueService.startProcessing({
				continueOnError: true,
				maxConcurrency: 1
			});

			vscode.window.showInformationMessage(
				`Started processing ${queueItems.length} items for content injection`
			);
		} catch (error) {
			this.logService.error('Failed to start processing:', error);
			vscode.window.showErrorMessage(`Failed to start processing: ${error}`);
		}
	}

	/**
	 * Retry failed items
	 */
	async retryFailedItems(): Promise<void> {
		try {
			const failedItems = this.fileQueueService.getItemsByStatus('failed');

			if (failedItems.length === 0) {
				vscode.window.showInformationMessage('No failed items to retry');
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				`Retry ${failedItems.length} failed item${failedItems.length !== 1 ? 's' : ''}?`,
				'Retry All',
				'Cancel'
			);

			if (confirmed !== 'Retry All') {
				return;
			}

			// Retry each failed item
			for (const item of failedItems) {
				await this.fileQueueService.retryItem(item.id);
			}

			vscode.window.showInformationMessage(
				`Queued ${failedItems.length} failed item${failedItems.length !== 1 ? 's' : ''} for retry`
			);

			this.logService.debug(`Retried ${failedItems.length} failed items`);
		} catch (error) {
			this.logService.error('Failed to retry failed items:', error);
			vscode.window.showErrorMessage(`Failed to retry failed items: ${error}`);
		}
	}

	/**
	 * Configure processing options
	 */
	async configureProcessing(): Promise<void> {
		try {
			const config = vscode.workspace.getConfiguration('github.copilot.fileQueue');

			const options = [
				{
					label: 'Max Concurrency',
					description: `Currently: ${config.get('maxConcurrency', 1)}`,
					value: 'maxConcurrency'
				},
				{
					label: 'Item Timeout',
					description: `Currently: ${config.get('itemTimeout', 60000)}ms`,
					value: 'itemTimeout'
				},
				{
					label: 'Continue On Error',
					description: `Currently: ${config.get('continueOnError', true)}`,
					value: 'continueOnError'
				},
				{
					label: 'Auto Retry',
					description: `Currently: ${config.get('autoRetry', false)}`,
					value: 'autoRetry'
				},
				{
					label: 'Max Retries',
					description: `Currently: ${config.get('maxRetries', 3)}`,
					value: 'maxRetries'
				}
			];

			const selected = await vscode.window.showQuickPick(options, {
				placeHolder: 'Select setting to configure'
			});

			if (!selected) {
				return;
			}

			await this.configureSetting(selected.value);
		} catch (error) {
			this.logService.error('Failed to configure processing:', error);
			vscode.window.showErrorMessage(`Failed to configure processing: ${error}`);
		}
	}

	private async configureSetting(settingKey: string): Promise<void> {
		const config = vscode.workspace.getConfiguration('github.copilot.fileQueue');
		const currentValue = config.get(settingKey);

		let newValue: any;

		switch (settingKey) {
			case 'maxConcurrency':
			case 'itemTimeout':
			case 'maxRetries':
				newValue = await vscode.window.showInputBox({
					prompt: `Enter new value for ${settingKey}`,
					value: currentValue?.toString(),
					validateInput: (value) => {
						const num = parseInt(value);
						return isNaN(num) || num < 1 ? 'Must be a positive number' : null;
					}
				});
				if (newValue) {
					newValue = parseInt(newValue);
				}
				break;

			case 'continueOnError':
			case 'autoRetry':
				const boolOptions = [
					{ label: 'True', value: true },
					{ label: 'False', value: false }
				];
				const selected = await vscode.window.showQuickPick(boolOptions, {
					placeHolder: `Select value for ${settingKey}`
				});
				newValue = selected?.value;
				break;
		}

		if (newValue !== undefined && newValue !== currentValue) {
			await config.update(settingKey, newValue, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(`Updated ${settingKey} to ${newValue}`);
		}
	}

	// Chat completion signaling commands

	/**
	 * Signal that the current chat processing has completed
	 */
	async signalChatComplete(): Promise<void> {
		try {
			this.fileQueueService.signalCurrentChatCompletion();
			this.logService.info('Signaled chat completion for current file');

			// Show a subtle notification
			vscode.window.setStatusBarMessage('Queue: Chat completion signaled', 3000);
		} catch (error) {
			this.logService.error('Failed to signal chat completion:', error);
			vscode.window.showErrorMessage(`Failed to signal chat completion: ${error}`);
		}
	}

	/**
	 * Signal that chat processing has completed for a specific file
	 */
	async signalChatCompleteForFile(filePath?: string): Promise<void> {
		try {
			if (!filePath) {
				// Show quick pick of active chat sessions
				const activeSessions = this.fileQueueService.getActiveChatSessions();

				if (activeSessions.length === 0) {
					vscode.window.showInformationMessage('No active chat sessions to signal completion for');
					return;
				}

				const sessionItems = activeSessions.map(session => ({
					label: vscode.workspace.asRelativePath(session.filePath),
					description: `${Math.round(session.duration / 1000)}s active`,
					detail: session.filePath,
					filePath: session.filePath
				}));

				const selected = await vscode.window.showQuickPick(sessionItems, {
					placeHolder: 'Select file to signal chat completion for'
				});

				if (!selected) {
					return;
				}

				filePath = selected.filePath;
			}

			this.fileQueueService.signalChatCompletion(filePath);
			this.logService.info(`Signaled chat completion for file: ${filePath}`);

			// Show a notification with the file name
			const fileName = vscode.workspace.asRelativePath(filePath);
			vscode.window.setStatusBarMessage(`Queue: Chat completion signaled for ${fileName}`, 3000);
		} catch (error) {
			this.logService.error('Failed to signal chat completion for file:', error);
			vscode.window.showErrorMessage(`Failed to signal chat completion: ${error}`);
		}
	}

	/**
	 * Show information about active chat sessions
	 */
	async showActiveChatSessions(): Promise<void> {
		try {
			const activeSessions = this.fileQueueService.getActiveChatSessions();

			if (activeSessions.length === 0) {
				vscode.window.showInformationMessage('No active chat sessions');
				return;
			}

			const sessionDetails = activeSessions.map(session => {
				const fileName = vscode.workspace.asRelativePath(session.filePath);
				const duration = Math.round(session.duration / 1000);
				return `• ${fileName} (${duration}s active)`;
			}).join('\n');

			const message = `Active Chat Sessions (${activeSessions.length}):\n${sessionDetails}`;

			// Show as information message with action to signal completion
			const selected = await vscode.window.showInformationMessage(
				`${activeSessions.length} active chat session${activeSessions.length !== 1 ? 's' : ''}`,
				'Signal Completion for One', 'Signal All Complete'
			);

			if (selected === 'Signal Completion for One') {
				await this.signalChatCompleteForFile();
			} else if (selected === 'Signal All Complete') {
				for (const session of activeSessions) {
					this.fileQueueService.signalChatCompletion(session.filePath);
				}
				vscode.window.showInformationMessage(`Signaled completion for all ${activeSessions.length} chat sessions`);
			}
		} catch (error) {
			this.logService.error('Failed to show active chat sessions:', error);
			vscode.window.showErrorMessage(`Failed to show active chat sessions: ${error}`);
		}
	}

}