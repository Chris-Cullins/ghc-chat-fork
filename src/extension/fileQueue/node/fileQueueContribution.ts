/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFileQueueService } from '../../../platform/fileQueue/common/fileQueueService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { FileQueueWebviewProvider } from '../webview/vscode-node/fileQueueWebviewProvider';

export class FileQueueContribution extends Disposable implements IExtensionContribution {
	readonly id = 'fileQueueContribution';

	private _webviewProvider: FileQueueWebviewProvider;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileQueueService private readonly fileQueueService: IFileQueueService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.logService.debug('FileQueueContribution initializing...');

		// Create and register the webview provider
		this._webviewProvider = this._register(
			this.instantiationService.createInstance(FileQueueWebviewProvider)
		);

		this._register(
			vscode.window.registerWebviewViewProvider(
				FileQueueWebviewProvider.viewType,
				this._webviewProvider,
				{
					webviewOptions: {
						retainContextWhenHidden: true
					}
				}
			)
		);

		// Register commands
		this._registerCommands();

		this.logService.debug('FileQueueContribution initialized successfully');
	}

	private _registerCommands(): void {
		// Command to add files to queue from explorer context
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.addFiles',
			async (...args: any[]) => {
				try {
					// Get file URIs from context or selection
					let fileUris: vscode.Uri[] = [];

					// Check if called from explorer context menu
					const firstArg = args[0];
					if (firstArg instanceof vscode.Uri) {
						fileUris = [firstArg];
					} else if (Array.isArray(firstArg)) {
						fileUris = firstArg.filter(uri => uri instanceof vscode.Uri);
					}

					// If no files from context, show file picker
					if (fileUris.length === 0) {
						const selectedFiles = await vscode.window.showOpenDialog({
							canSelectFiles: true,
							canSelectFolders: false,
							canSelectMany: true,
							title: 'Select files to add to processing queue'
						});

						if (selectedFiles) {
							fileUris = selectedFiles;
						}
					}

					if (fileUris.length === 0) {
						return; // User cancelled or no files selected
					}

					// Add files to queue
					const filePaths = fileUris.map(uri => uri.fsPath);
					const itemIds = await this.fileQueueService.addMultipleToQueue(filePaths);

					vscode.window.showInformationMessage(
						`Added ${itemIds.length} file${itemIds.length !== 1 ? 's' : ''} to processing queue`
					);

					this.logService.debug(`Added ${itemIds.length} files to queue: ${filePaths.join(', ')}`);
				} catch (error) {
					this.logService.error('Failed to add files to queue:', error);
					vscode.window.showErrorMessage(`Failed to add files to queue: ${error}`);
				}
			}
		));

		// Command to add current file to queue
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.addCurrentFile',
			async () => {
				try {
					const activeEditor = vscode.window.activeTextEditor;
					if (!activeEditor) {
						vscode.window.showWarningMessage('No file is currently open');
						return;
					}

					const filePath = activeEditor.document.uri.fsPath;
					if (!filePath) {
						vscode.window.showWarningMessage('Current file cannot be added to queue');
						return;
					}

					const itemId = await this.fileQueueService.addToQueue(filePath);
					vscode.window.showInformationMessage(`Added "${activeEditor.document.fileName}" to processing queue`);

					this.logService.debug(`Added current file to queue: ${filePath} (ID: ${itemId})`);
				} catch (error) {
					this.logService.error('Failed to add current file to queue:', error);
					vscode.window.showErrorMessage(`Failed to add current file to queue: ${error}`);
				}
			}
		));

		// Command to start processing
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.startProcessing',
			async () => {
				try {
					await this.fileQueueService.startProcessing();
					vscode.window.showInformationMessage('Started queue processing');
					this.logService.debug('Started queue processing via command');
				} catch (error) {
					this.logService.error('Failed to start processing:', error);
					vscode.window.showErrorMessage(`Failed to start processing: ${error}`);
				}
			}
		));

		// Command to pause processing
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.pauseProcessing',
			async () => {
				try {
					await this.fileQueueService.pauseProcessing();
					vscode.window.showInformationMessage('Paused queue processing');
					this.logService.debug('Paused queue processing via command');
				} catch (error) {
					this.logService.error('Failed to pause processing:', error);
					vscode.window.showErrorMessage(`Failed to pause processing: ${error}`);
				}
			}
		));

		// Command to stop processing
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.stopProcessing',
			async () => {
				try {
					await this.fileQueueService.stopProcessing();
					vscode.window.showInformationMessage('Stopped queue processing');
					this.logService.debug('Stopped queue processing via command');
				} catch (error) {
					this.logService.error('Failed to stop processing:', error);
					vscode.window.showErrorMessage(`Failed to stop processing: ${error}`);
				}
			}
		));

		// Command to clear queue
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.clearQueue',
			async () => {
				try {
					const queueState = this.fileQueueService.getQueueState();
					const itemCount = this.fileQueueService.getQueueItems().length;

					if (itemCount === 0) {
						vscode.window.showInformationMessage('Queue is already empty');
						return;
					}

					let includeProcessing = false;
					if (queueState.isProcessing) {
						const action = await vscode.window.showWarningMessage(
							'Queue is currently processing. What would you like to do?',
							'Clear pending only',
							'Stop processing and clear all',
							'Cancel'
						);

						if (action === 'Cancel' || !action) {
							return;
						}

						includeProcessing = action === 'Stop processing and clear all';
					} else {
						const confirmed = await vscode.window.showWarningMessage(
							`Are you sure you want to clear ${itemCount} item${itemCount !== 1 ? 's' : ''} from the queue?`,
							'Clear Queue',
							'Cancel'
						);

						if (confirmed !== 'Clear Queue') {
							return;
						}
					}

					await this.fileQueueService.clearQueue(includeProcessing);
					vscode.window.showInformationMessage('Queue cleared');
					this.logService.debug(`Cleared queue (includeProcessing: ${includeProcessing})`);
				} catch (error) {
					this.logService.error('Failed to clear queue:', error);
					vscode.window.showErrorMessage(`Failed to clear queue: ${error}`);
				}
			}
		));

		// Command to show queue statistics
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.showStatistics',
			async () => {
				try {
					const stats = this.fileQueueService.getQueueStatistics();
					const queueState = this.fileQueueService.getQueueState();

					const message = `Queue Statistics:
• Total Processed: ${stats.totalProcessed}
• Success Rate: ${stats.totalProcessed > 0 ? Math.round(stats.successRate * 100) : 0}%
• Average Processing Time: ${stats.averageProcessingTime > 0 ? Math.round(stats.averageProcessingTime / 1000) : 0}s
• Current Queue Size: ${stats.currentQueueSize}
• Status: ${queueState.isProcessing ? (queueState.isPaused ? 'Paused' : 'Processing') : 'Idle'}`;

					vscode.window.showInformationMessage(message, { modal: false });
					this.logService.debug('Showed queue statistics');
				} catch (error) {
					this.logService.error('Failed to show statistics:', error);
					vscode.window.showErrorMessage(`Failed to show statistics: ${error}`);
				}
			}
		));

		// Command to export queue
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.exportQueue',
			async () => {
				try {
					const queueData = this.fileQueueService.exportQueue();

					const saveUri = await vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file('file-queue-export.json'),
						filters: {
							'JSON Files': ['json'],
							'All Files': ['*']
						},
						title: 'Export Queue Data'
					});

					if (!saveUri) {
						return; // User cancelled
					}

					await vscode.workspace.fs.writeFile(saveUri, Buffer.from(queueData, 'utf8'));

					const openAction = 'Open File';
					const result = await vscode.window.showInformationMessage(
						`Queue exported to ${saveUri.fsPath}`,
						openAction
					);

					if (result === openAction) {
						await vscode.commands.executeCommand('vscode.open', saveUri);
					}

					this.logService.debug(`Exported queue to: ${saveUri.fsPath}`);
				} catch (error) {
					this.logService.error('Failed to export queue:', error);
					vscode.window.showErrorMessage(`Failed to export queue: ${error}`);
				}
			}
		));

		// Command to import queue
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.importQueue',
			async () => {
				try {
					const fileUri = await vscode.window.showOpenDialog({
						canSelectFiles: true,
						canSelectFolders: false,
						canSelectMany: false,
						filters: {
							'JSON Files': ['json'],
							'All Files': ['*']
						},
						title: 'Import Queue Data'
					});

					if (!fileUri || fileUri.length === 0) {
						return; // User cancelled
					}

					const data = await vscode.workspace.fs.readFile(fileUri[0]);
					const queueData = data.toString();

					// Ask about merge vs replace
					const action = await vscode.window.showQuickPick(
						[
							{ label: 'Replace current queue', value: false },
							{ label: 'Merge with current queue', value: true }
						],
						{
							placeHolder: 'How would you like to import the queue data?'
						}
					);

					if (!action) {
						return; // User cancelled
					}

					await this.fileQueueService.importQueue(queueData, action.value);
					vscode.window.showInformationMessage('Queue imported successfully');

					this.logService.debug(`Imported queue from: ${fileUri[0].fsPath} (merge: ${action.value})`);
				} catch (error) {
					this.logService.error('Failed to import queue:', error);
					vscode.window.showErrorMessage(`Failed to import queue: ${error}`);
				}
			}
		));

		// Command to focus on queue view
		this._register(vscode.commands.registerCommand(
			'github.copilot.fileQueue.focus',
			async () => {
				await vscode.commands.executeCommand('github.copilot.fileQueue.focus');
			}
		));
	}
}