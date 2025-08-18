/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFileQueueService, FileQueueItem, ProcessingResult } from '../../../platform/fileQueue/common/fileQueueService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { ChatMonitor } from './chatMonitor';

/**
 * Handles the actual file processing with VS Code integration.
 * This is in the extension layer so it can call VS Code commands.
 */
export class FileQueueProcessor {
	private readonly chatMonitor: ChatMonitor;

	constructor(
		private readonly fileQueueService: IFileQueueService,
		private readonly logService: ILogService
	) {
		this.chatMonitor = new ChatMonitor(this.logService);
	}

	async processFile(item: FileQueueItem, cancellationToken: CancellationToken): Promise<ProcessingResult> {
		const startTime = Date.now();

		try {
			this.logService.info(`DEBUG: Starting processFile for: ${item.filePath}`);

			// Create a chat message that includes the file content
			const operation = item.metadata?.operation || 'analyze';
			const fileName = item.fileName;
			this.logService.info(`DEBUG: Creating chat query for operation: ${operation}, fileName: ${fileName}`);
			const chatQuery = this._createChatQuery(operation, fileName);
			this.logService.info(`DEBUG: Chat query created: ${chatQuery}`);

			// Attach file to chat and open with processing instruction
			try {
				this.logService.info(`DEBUG: About to call _openChatWithFile`);
				await this._openChatWithFile(item.filePath, item.fileName, chatQuery);
				this.logService.info(`DEBUG: _openChatWithFile completed successfully`);
			} catch (error) {
				this.logService.error(`DEBUG: _openChatWithFile failed:`, error);
				throw new Error(`Failed to attach file to chat: ${error}`);
			}

			// Wait for user to indicate they're ready for the next file
			// This ensures we don't overwhelm the chat system and allows proper sequential processing
			this.logService.info(`DEBUG: Waiting for chat processing completion signal for: ${item.filePath}`);
			await this._waitForChatCompletion(item.filePath, cancellationToken);
			this.logService.info(`DEBUG: Chat processing completion confirmed for: ${item.filePath}`);

			const duration = Date.now() - startTime;
			this.logService.info(`DEBUG: Processing completed for ${item.filePath}, duration: ${duration}ms`);

			return {
				success: true,
				message: `File ${fileName} attached to chat and processing completed`,
				duration,
				data: {
					operation,
					fileName,
					filePath: item.filePath
				}
			};

		} catch (error) {
			const duration = Date.now() - startTime;
			return {
				success: false,
				message: `Failed to process file: ${error instanceof Error ? error.message : String(error)}`,
				duration,
				error: error instanceof Error ? error : new Error(String(error))
			};
		}
	}

	private _createChatQuery(operation: string, fileName: string): string {
		// Simple prompt that tells the user what file is being processed
		return `Please process ${fileName}`;
	}

	private async _openChatWithFile(filePath: string, fileName: string, chatPrompt: string): Promise<vscode.ChatRequest | undefined> {
		try {
			this.logService.info(`Opening Copilot Chat for file: ${filePath}`);

			// Record the start of chat interaction for this file
			// (This is now handled through the service interface)

			// Check if we should reset chat context before processing this file
			const shouldResetChat = (this.fileQueueService as any).getResetChatBetweenFiles?.() ?? false;
			if (shouldResetChat) {
				this.logService.info('Resetting chat context before processing new file');
				// Execute the new chat command to clear the context
				try {
					await vscode.commands.executeCommand('workbench.action.chat.clear');
				} catch (clearError) {
					// If clear command doesn't exist, try alternative approaches
					this.logService.debug('Chat clear command not available, trying alternative');
					try {
						// Try to open a new chat session
						await vscode.commands.executeCommand('workbench.action.chat.newChat');
					} catch (newChatError) {
						// As a fallback, just open the chat panel which might reset context
						this.logService.debug('New chat command not available, opening fresh chat panel');
						await vscode.commands.executeCommand('workbench.action.chat.open');
					}
				}
				// Small delay after reset to ensure it completes
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			// First, attach the file to chat using VS Code command
			this.logService.info(`Attaching file to chat: ${filePath}`);
			await vscode.commands.executeCommand('workbench.action.chat.attachFile', vscode.Uri.file(filePath));

			// Small delay to allow attachment to complete
			await new Promise(resolve => setTimeout(resolve, 1000));

			// Then open/focus the chat view with a pre-filled query
			this.logService.info('Opening Copilot Chat view with analysis query');
			const result = await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: chatPrompt
			});

			this.logService.info(`Successfully opened Copilot Chat with file: ${fileName}. Result:`, typeof result);

			// Try to return the chat request if available
			return result as vscode.ChatRequest;

		} catch (error) {
			this.logService.error(`Failed to open Copilot Chat for file: ${filePath}`, error);
			throw error;
		}
	}

	private async _waitForChatCompletion(filePath: string, cancellationToken: CancellationToken): Promise<void> {
		// Strategy: Use proper chat monitoring to detect actual completion
		// No artificial timeouts - wait for real completion signals or activity detection

		const startTime = Date.now();
		const safetyTimeout = 60 * 60 * 1000; // 1 hour safety net (for truly infinite loops)

		this.logService.info(`DEBUG: Waiting for chat completion using activity monitoring: ${filePath}`);

		try {
			// Create a promise that resolves on actual completion detection
			const completionPromise = new Promise<void>((resolve, reject) => {
				let safetyTimeoutHandle: NodeJS.Timeout | undefined;
				let activityCheckInterval: NodeJS.Timeout | undefined;
				let lastActivityTime = Date.now();
				let consecutiveInactiveChecks = 0;
				let isCleanedUp = false; // Guard against multiple cleanup calls

				// Set up callback for manual completion signaling
				const originalCallback = (this.fileQueueService as any)._chatCompletionCallbacks?.get(filePath);
				const completionCallback = () => {
					if (isCleanedUp) return; // Prevent recursion
					this.logService.info(`DEBUG: Manual completion signal received for: ${filePath}`);
					cleanup();
					resolve();
				};

				// Store the callback in the service for manual signaling
				if ((this.fileQueueService as any)._chatCompletionCallbacks) {
					(this.fileQueueService as any)._chatCompletionCallbacks.set(filePath, completionCallback);
				}

				const cleanup = () => {
					if (isCleanedUp) return; // Prevent multiple cleanup calls
					isCleanedUp = true;

					if (safetyTimeoutHandle) clearTimeout(safetyTimeoutHandle);
					if (activityCheckInterval) clearInterval(activityCheckInterval);

					// Clean up chat monitoring
					this.chatMonitor.stopMonitoring(filePath);

					// Remove our callback but restore any original
					if ((this.fileQueueService as any)._chatCompletionCallbacks) {
						if (originalCallback) {
							(this.fileQueueService as any)._chatCompletionCallbacks.set(filePath, originalCallback);
						} else {
							(this.fileQueueService as any)._chatCompletionCallbacks.delete(filePath);
						}
					}
				};

				// Safety timeout - only for truly stuck situations (1 hour)
				safetyTimeoutHandle = setTimeout(() => {
					const elapsed = Date.now() - startTime;
					this.logService.warn(`DEBUG: Safety timeout reached for: ${filePath} after ${elapsed}ms - this suggests a stuck situation`);
					cleanup();
					resolve();
				}, safetyTimeout);

				// Start chat monitoring
				this.chatMonitor.startMonitoring(filePath);
				this.chatMonitor.registerCompletionCallback(filePath, () => {
					this.logService.info(`DEBUG: Chat monitor detected completion for: ${filePath}`);
					cleanup();
					resolve();
				});

				// Activity-based completion detection - the core logic
				activityCheckInterval = setInterval(async () => {
					try {
						const elapsed = Date.now() - startTime;

						// Use the ChatMonitor to detect activity
						const hasActivity = await this.chatMonitor.detectChatActivity(filePath);

						if (hasActivity) {
							// Reset inactivity counter
							lastActivityTime = Date.now();
							consecutiveInactiveChecks = 0;
							this.logService.debug(`DEBUG: Chat activity detected for: ${filePath} at ${elapsed}ms`);
						} else {
							consecutiveInactiveChecks++;
							const inactiveTime = Date.now() - lastActivityTime;

							this.logService.debug(`DEBUG: No activity detected for: ${filePath} (${consecutiveInactiveChecks} checks, ${inactiveTime}ms inactive)`);

							// Require multiple consecutive inactive checks before considering done
							// This prevents false positives from brief pauses in chat output
							// Since we now have proper completion signaling, this is just a backup
							const requiredInactiveChecks = 720; // 720 checks * 5 seconds = 1 hour of inactivity
							const maxInactiveTime = 3600000; // 1 hour

							if (consecutiveInactiveChecks >= requiredInactiveChecks && inactiveTime >= maxInactiveTime) {
								this.logService.info(`DEBUG: Sustained inactivity detected for: ${filePath} after ${elapsed}ms (${inactiveTime}ms inactive) - assuming completion`);
								cleanup();
								resolve();
								return;
							}
						}

					} catch (error) {
						this.logService.debug(`DEBUG: Error in activity check: ${error}`);
					}
				}, 5000); // Check every 5 seconds

				// Set up cancellation handling
				if (cancellationToken.isCancellationRequested) {
					cleanup();
					reject(new Error('Processing was cancelled'));
					return;
				}

				const cancelListener = cancellationToken.onCancellationRequested(() => {
					cleanup();
					cancelListener.dispose();
					reject(new Error('Processing was cancelled'));
				});

				// Add cleanup to resolve
				const originalResolve = resolve;
				resolve = () => {
					cancelListener.dispose();
					originalResolve();
				};
			});

			await completionPromise;

			const totalElapsed = Date.now() - startTime;
			this.logService.info(`DEBUG: Chat completion detected for: ${filePath} after ${totalElapsed}ms`);

		} catch (error) {
			if (cancellationToken.isCancellationRequested) {
				this.logService.info(`DEBUG: Chat completion wait cancelled for: ${filePath}`);
			} else {
				this.logService.warn(`DEBUG: Chat completion wait error for: ${filePath}: ${error}`);
			}
			throw error;
		}
	}

}