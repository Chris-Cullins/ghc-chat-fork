/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import {
	ConditionType,
	IAutoPermissionService,
	PermissionAuditEntry,
	PermissionChangeEvent,
	PermissionContext,
	PermissionDecision,
	PermissionDecisionEvent,
	PermissionEvaluationOptions,
	PermissionOperation,
	PermissionProfile,
	PermissionResult,
	PermissionRule,
	PermissionScope,
	PermissionStatistics,
	RiskLevel,
	RuleCondition
} from '../common/autoPermissionService';

interface ServiceConfiguration {
	enabled: boolean;
	defaultProfile: string;
	auditEnabled: boolean;
	maxAuditEntries: number;
	cacheEnabled: boolean;
	cacheTTL: number;
}

interface CacheEntry {
	result: PermissionResult;
	timestamp: number;
	ttl: number;
}

export class AutoPermissionServiceImpl extends Disposable implements IAutoPermissionService {
	readonly _serviceBrand: undefined;

	private readonly _onPermissionChange = this._register(new Emitter<PermissionChangeEvent>());
	readonly onPermissionChange = this._onPermissionChange.event;

	private readonly _onPermissionDecision = this._register(new Emitter<PermissionDecisionEvent>());
	readonly onPermissionDecision = this._onPermissionDecision.event;

	private readonly _onError = this._register(new Emitter<{ error: Error; context?: PermissionContext }>());
	readonly onError = this._onError.event;

	private _profiles: Map<string, PermissionProfile> = new Map();
	private _activeProfileId: string | undefined;
	private _auditLog: PermissionAuditEntry[] = [];
	private _configuration: ServiceConfiguration;
	private _cache: Map<string, CacheEntry> = new Map();

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super();

		this._configuration = {
			enabled: true,
			defaultProfile: 'conservative',
			auditEnabled: true,
			maxAuditEntries: 10000,
			cacheEnabled: true,
			cacheTTL: 300000 // 5 minutes
		};

		this._loadState();
		this._initializeBuiltInProfiles();

		// Clean up cache periodically
		this._register(setInterval(() => this._cleanupCache(), 60000)); // Every minute
	}

	// Profile Management

	async createProfile(profile: Omit<PermissionProfile, 'id' | 'createdAt' | 'modifiedAt' | 'version'>): Promise<string> {
		const id = generateUuid();
		const newProfile: PermissionProfile = {
			...profile,
			id,
			createdAt: new Date(),
			modifiedAt: new Date(),
			version: 1
		};

		this._profiles.set(id, newProfile);
		await this._saveState();

		this._onPermissionChange.fire({
			type: 'profileCreated',
			profileId: id,
			timestamp: new Date()
		});

		this._logService.info(`AutoPermissionService: Created profile ${profile.name} (${id})`);
		return id;
	}

	async updateProfile(profileId: string, updates: Partial<PermissionProfile>): Promise<void> {
		const profile = this._profiles.get(profileId);
		if (!profile) {
			throw new Error(`Profile ${profileId} not found`);
		}

		if (profile.isBuiltIn && updates.rules) {
			throw new Error('Cannot modify rules of built-in profiles');
		}

		const updatedProfile: PermissionProfile = {
			...profile,
			...updates,
			id: profileId, // Ensure ID doesn't change
			modifiedAt: new Date(),
			version: profile.version + 1
		};

		this._profiles.set(profileId, updatedProfile);
		await this._saveState();

		this._onPermissionChange.fire({
			type: 'profileUpdated',
			profileId,
			timestamp: new Date()
		});

		this._logService.info(`AutoPermissionService: Updated profile ${profileId}`);
	}

	async deleteProfile(profileId: string): Promise<void> {
		const profile = this._profiles.get(profileId);
		if (!profile) {
			throw new Error(`Profile ${profileId} not found`);
		}

		if (profile.isBuiltIn) {
			throw new Error('Cannot delete built-in profiles');
		}

		if (this._activeProfileId === profileId) {
			// Switch to conservative profile if deleting active profile
			const conservativeProfile = Array.from(this._profiles.values()).find(p => p.securityLevel === 'conservative');
			this._activeProfileId = conservativeProfile?.id;
		}

		this._profiles.delete(profileId);
		await this._saveState();

		this._onPermissionChange.fire({
			type: 'profileDeleted',
			profileId,
			timestamp: new Date()
		});

		this._logService.info(`AutoPermissionService: Deleted profile ${profileId}`);
	}

	getProfiles(): PermissionProfile[] {
		return Array.from(this._profiles.values());
	}

	getProfile(profileId: string): PermissionProfile | undefined {
		return this._profiles.get(profileId);
	}

	async setActiveProfile(profileId: string): Promise<void> {
		const profile = this._profiles.get(profileId);
		if (!profile) {
			throw new Error(`Profile ${profileId} not found`);
		}

		// Deactivate current profile
		if (this._activeProfileId) {
			const currentProfile = this._profiles.get(this._activeProfileId);
			if (currentProfile) {
				currentProfile.isActive = false;
			}
		}

		// Activate new profile
		profile.isActive = true;
		this._activeProfileId = profileId;
		await this._saveState();

		this._onPermissionChange.fire({
			type: 'profileActivated',
			profileId,
			timestamp: new Date()
		});

		this._logService.info(`AutoPermissionService: Activated profile ${profile.name} (${profileId})`);
	}

	getActiveProfile(): PermissionProfile | undefined {
		return this._activeProfileId ? this._profiles.get(this._activeProfileId) : undefined;
	}

	// Rule Management

	async addRule(profileId: string, rule: Omit<PermissionRule, 'id' | 'createdAt' | 'modifiedAt'>): Promise<string> {
		const profile = this._profiles.get(profileId);
		if (!profile) {
			throw new Error(`Profile ${profileId} not found`);
		}

		if (profile.isBuiltIn) {
			throw new Error('Cannot add rules to built-in profiles');
		}

		const id = generateUuid();
		const newRule: PermissionRule = {
			...rule,
			id,
			createdAt: new Date(),
			modifiedAt: new Date()
		};

		profile.rules.push(newRule);
		profile.modifiedAt = new Date();
		profile.version++;

		await this._saveState();

		this._onPermissionChange.fire({
			type: 'ruleChanged',
			profileId,
			ruleId: id,
			timestamp: new Date()
		});

		this._logService.info(`AutoPermissionService: Added rule ${rule.name} to profile ${profileId}`);
		return id;
	}

	async updateRule(profileId: string, ruleId: string, updates: Partial<PermissionRule>): Promise<void> {
		const profile = this._profiles.get(profileId);
		if (!profile) {
			throw new Error(`Profile ${profileId} not found`);
		}

		if (profile.isBuiltIn) {
			throw new Error('Cannot modify rules of built-in profiles');
		}

		const ruleIndex = profile.rules.findIndex(r => r.id === ruleId);
		if (ruleIndex === -1) {
			throw new Error(`Rule ${ruleId} not found in profile ${profileId}`);
		}

		const updatedRule: PermissionRule = {
			...profile.rules[ruleIndex],
			...updates,
			id: ruleId, // Ensure ID doesn't change
			modifiedAt: new Date()
		};

		profile.rules[ruleIndex] = updatedRule;
		profile.modifiedAt = new Date();
		profile.version++;

		await this._saveState();

		this._onPermissionChange.fire({
			type: 'ruleChanged',
			profileId,
			ruleId,
			timestamp: new Date()
		});

		this._logService.info(`AutoPermissionService: Updated rule ${ruleId} in profile ${profileId}`);
	}

	async deleteRule(profileId: string, ruleId: string): Promise<void> {
		const profile = this._profiles.get(profileId);
		if (!profile) {
			throw new Error(`Profile ${profileId} not found`);
		}

		if (profile.isBuiltIn) {
			throw new Error('Cannot delete rules from built-in profiles');
		}

		const ruleIndex = profile.rules.findIndex(r => r.id === ruleId);
		if (ruleIndex === -1) {
			throw new Error(`Rule ${ruleId} not found in profile ${profileId}`);
		}

		profile.rules.splice(ruleIndex, 1);
		profile.modifiedAt = new Date();
		profile.version++;

		await this._saveState();

		this._onPermissionChange.fire({
			type: 'ruleChanged',
			profileId,
			ruleId,
			timestamp: new Date()
		});

		this._logService.info(`AutoPermissionService: Deleted rule ${ruleId} from profile ${profileId}`);
	}

	getRules(profileId: string): PermissionRule[] {
		const profile = this._profiles.get(profileId);
		if (!profile) {
			throw new Error(`Profile ${profileId} not found`);
		}
		return [...profile.rules];
	}

	// Permission Evaluation

	async evaluatePermission(context: PermissionContext, options: PermissionEvaluationOptions = {}): Promise<PermissionResult> {
		const startTime = Date.now();

		try {
			// Check if service is enabled
			if (!this._configuration.enabled) {
				return this._createPermissionResult(PermissionDecision.Prompt, 'Auto-permission service is disabled', startTime);
			}

			// Check cache first
			if (this._configuration.cacheEnabled && options.useCache !== false) {
				const cacheKey = this._getCacheKey(context);
				const cached = this._cache.get(cacheKey);
				if (cached && Date.now() - cached.timestamp < cached.ttl) {
					this._logService.debug(`AutoPermissionService: Using cached result for ${context.operation} on ${context.uri.toString()}`);
					return cached.result;
				}
			}

			// Get active profile or use specified profile
			const profileId = options.profileId || this._activeProfileId || this._configuration.defaultProfile;
			const profile = this._profiles.get(profileId);

			if (!profile) {
				return this._createPermissionResult(PermissionDecision.Prompt, 'No active permission profile found', startTime);
			}

			// Evaluate rules in priority order
			const sortedRules = profile.rules
				.filter(rule => rule.enabled)
				.sort((a, b) => b.priority - a.priority);

			for (const rule of sortedRules) {
				if (this._ruleMatches(rule, context)) {
					const result = this._createPermissionResult(
						rule.decision,
						`Matched rule: ${rule.name} - ${rule.description}`,
						startTime,
						rule
					);

					// Cache the result if it's cacheable
					if (this._configuration.cacheEnabled && result.cacheable) {
						const cacheKey = this._getCacheKey(context);
						this._cache.set(cacheKey, {
							result,
							timestamp: Date.now(),
							ttl: result.cacheTimeout || this._configuration.cacheTTL
						});
					}

					// Log the decision
					if (this._configuration.auditEnabled && options.enableAuditLog !== false) {
						this._logPermissionDecision(context, result, true);
					}

					// Fire event
					this._onPermissionDecision.fire({ context, result, timestamp: new Date() });

					this._logService.debug(`AutoPermissionService: Rule ${rule.name} matched for ${context.operation} on ${context.uri.toString()}: ${rule.decision}`);
					return result;
				}
			}

			// No rules matched, use profile default
			const result = this._createPermissionResult(
				profile.defaultDecision,
				'No matching rules found, using profile default',
				startTime
			);

			// Log the decision
			if (this._configuration.auditEnabled && options.enableAuditLog !== false) {
				this._logPermissionDecision(context, result, true);
			}

			// Fire event
			this._onPermissionDecision.fire({ context, result, timestamp: new Date() });

			this._logService.debug(`AutoPermissionService: No rules matched for ${context.operation} on ${context.uri.toString()}, using default: ${profile.defaultDecision}`);
			return result;

		} catch (error) {
			const result = this._createPermissionResult(PermissionDecision.Prompt, `Error evaluating permission: ${error}`, startTime);
			this._onError.fire({ error: error as Error, context });
			this._logService.error(`AutoPermissionService: Error evaluating permission`, error);
			return result;
		}
	}

	async wouldAutoApprove(context: PermissionContext, options: PermissionEvaluationOptions = {}): Promise<boolean> {
		const result = await this.evaluatePermission(context, { ...options, enableAuditLog: false });
		return result.decision === PermissionDecision.Allow;
	}

	async manuallyApprove(context: PermissionContext, createRule = false): Promise<void> {
		const result: PermissionResult = {
			decision: PermissionDecision.Allow,
			reason: 'Manually approved by user',
			riskLevel: RiskLevel.Low,
			requiresConfirmation: false,
			evaluationTime: 0,
			cacheable: false
		};

		if (this._configuration.auditEnabled) {
			this._logPermissionDecision(context, result, true);
		}

		if (createRule) {
			await this._createRuleFromContext(context, PermissionDecision.Allow);
		}

		this._onPermissionDecision.fire({ context, result, timestamp: new Date() });
		this._logService.info(`AutoPermissionService: Manually approved ${context.operation} on ${context.uri.toString()}`);
	}

	async manuallyDeny(context: PermissionContext, createRule = false): Promise<void> {
		const result: PermissionResult = {
			decision: PermissionDecision.Deny,
			reason: 'Manually denied by user',
			riskLevel: RiskLevel.Medium,
			requiresConfirmation: false,
			evaluationTime: 0,
			cacheable: false
		};

		if (this._configuration.auditEnabled) {
			this._logPermissionDecision(context, result, false);
		}

		if (createRule) {
			await this._createRuleFromContext(context, PermissionDecision.Deny);
		}

		this._onPermissionDecision.fire({ context, result, timestamp: new Date() });
		this._logService.info(`AutoPermissionService: Manually denied ${context.operation} on ${context.uri.toString()}`);
	}

	// Audit and Logging

	getAuditLog(limit = 1000, filter?: Partial<PermissionAuditEntry>): PermissionAuditEntry[] {
		let entries = [...this._auditLog];

		if (filter) {
			entries = entries.filter(entry => {
				return Object.entries(filter).every(([key, value]) => {
					const entryValue = (entry as any)[key];
					return entryValue === value;
				});
			});
		}

		return entries
			.sort((a, b) => b.context.timestamp.getTime() - a.context.timestamp.getTime())
			.slice(0, limit);
	}

	async clearAuditLog(olderThan?: Date): Promise<void> {
		if (olderThan) {
			this._auditLog = this._auditLog.filter(entry => entry.context.timestamp >= olderThan);
		} else {
			this._auditLog = [];
		}

		await this._saveState();
		this._logService.info(`AutoPermissionService: Cleared audit log${olderThan ? ` (entries older than ${olderThan.toISOString()})` : ''}`);
	}

	async exportAuditLog(format: 'json' | 'csv'): Promise<string> {
		if (format === 'json') {
			return JSON.stringify(this._auditLog, null, 2);
		} else {
			// CSV export
			const headers = 'Timestamp,Operation,URI,Decision,Reason,Executed,Tool,Risk Level\n';
			const rows = this._auditLog.map(entry => {
				const timestamp = entry.context.timestamp.toISOString();
				const operation = entry.context.operation;
				const uri = entry.context.uri.toString();
				const decision = entry.result.decision;
				const reason = entry.result.reason.replace(/,/g, ';'); // Escape commas
				const executed = entry.executed;
				const tool = entry.context.requestingTool;
				const riskLevel = entry.result.riskLevel;

				return `${timestamp},${operation},${uri},${decision},${reason},${executed},${tool},${riskLevel}`;
			});

			return headers + rows.join('\n');
		}
	}

	getStatistics(timeRange?: { start: Date; end: Date }): PermissionStatistics {
		let entries = this._auditLog;

		if (timeRange) {
			entries = entries.filter(entry =>
				entry.context.timestamp >= timeRange.start && entry.context.timestamp <= timeRange.end
			);
		}

		const totalRequests = entries.length;
		const decisionCounts: Record<PermissionDecision, number> = {
			[PermissionDecision.Allow]: 0,
			[PermissionDecision.Deny]: 0,
			[PermissionDecision.Prompt]: 0
		};
		const operationCounts: Record<PermissionOperation, number> = {} as any;
		const riskLevelCounts: Record<RiskLevel, number> = {
			[RiskLevel.Low]: 0,
			[RiskLevel.Medium]: 0,
			[RiskLevel.High]: 0,
			[RiskLevel.Critical]: 0
		};

		const ruleCounts = new Map<string, number>();
		let totalEvaluationTime = 0;

		for (const entry of entries) {
			decisionCounts[entry.result.decision]++;
			operationCounts[entry.context.operation] = (operationCounts[entry.context.operation] || 0) + 1;
			riskLevelCounts[entry.result.riskLevel]++;
			totalEvaluationTime += entry.result.evaluationTime;

			if (entry.result.matchedRule) {
				const count = ruleCounts.get(entry.result.matchedRule.id) || 0;
				ruleCounts.set(entry.result.matchedRule.id, count + 1);
			}
		}

		const topRules = Array.from(ruleCounts.entries())
			.map(([ruleId, count]) => ({ ruleId, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		return {
			totalRequests,
			decisionCounts,
			operationCounts,
			riskLevelCounts,
			averageEvaluationTime: totalRequests > 0 ? totalEvaluationTime / totalRequests : 0,
			topRules,
			periodStart: timeRange?.start || new Date(Math.min(...entries.map(e => e.context.timestamp.getTime()))),
			periodEnd: timeRange?.end || new Date(Math.max(...entries.map(e => e.context.timestamp.getTime())))
		};
	}

	// Configuration

	getConfiguration() {
		return { ...this._configuration };
	}

	async updateConfiguration(config: Partial<ServiceConfiguration>): Promise<void> {
		this._configuration = { ...this._configuration, ...config };
		await this._saveState();
		this._logService.info('AutoPermissionService: Configuration updated');
	}

	// Built-in Profiles

	async initializeBuiltInProfiles(): Promise<void> {
		await this._initializeBuiltInProfiles();
	}

	async resetBuiltInProfile(profileId: string): Promise<void> {
		const profile = this._profiles.get(profileId);
		if (!profile || !profile.isBuiltIn) {
			throw new Error(`Built-in profile ${profileId} not found`);
		}

		// Remove existing profile and recreate
		this._profiles.delete(profileId);
		await this._createBuiltInProfile(profile.securityLevel);
		await this._saveState();

		this._logService.info(`AutoPermissionService: Reset built-in profile ${profileId}`);
	}

	// Utility Methods

	async testRule(rule: PermissionRule, testCases: PermissionContext[]): Promise<Array<{
		context: PermissionContext;
		matches: boolean;
		reason: string;
	}>> {
		return testCases.map(context => {
			try {
				const matches = this._ruleMatches(rule, context);
				return {
					context,
					matches,
					reason: matches ? 'Rule conditions satisfied' : 'Rule conditions not met'
				};
			} catch (error) {
				return {
					context,
					matches: false,
					reason: `Error evaluating rule: ${error}`
				};
			}
		});
	}

	validateRule(rule: PermissionRule): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		if (!rule.name || rule.name.trim().length === 0) {
			errors.push('Rule name is required');
		}

		if (!rule.description || rule.description.trim().length === 0) {
			errors.push('Rule description is required');
		}

		if (rule.priority < 0 || rule.priority > 1000) {
			errors.push('Rule priority must be between 0 and 1000');
		}

		if (!rule.conditions || rule.conditions.length === 0) {
			errors.push('Rule must have at least one condition');
		}

		// Validate conditions
		for (const condition of rule.conditions || []) {
			const conditionErrors = this._validateCondition(condition);
			errors.push(...conditionErrors);
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}

	async getSuggestedRules(lookbackDays = 30): Promise<PermissionRule[]> {
		const cutoffDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
		const recentEntries = this._auditLog.filter(entry => entry.context.timestamp >= cutoffDate);

		// Group by operation and file pattern to find common patterns
		const patterns = new Map<string, { count: number; decisions: PermissionDecision[] }>();

		for (const entry of recentEntries) {
			const extension = this._getFileExtension(entry.context.uri.path);
			const key = `${entry.context.operation}-${extension}`;

			if (!patterns.has(key)) {
				patterns.set(key, { count: 0, decisions: [] });
			}

			const pattern = patterns.get(key)!;
			pattern.count++;
			pattern.decisions.push(entry.result.decision);
		}

		const suggestedRules: PermissionRule[] = [];

		// Create rules for patterns that have consistent decisions
		for (const [key, pattern] of patterns) {
			if (pattern.count >= 5) { // At least 5 occurrences
				const [operation, extension] = key.split('-');
				const allowCount = pattern.decisions.filter(d => d === PermissionDecision.Allow).length;
				const denyCount = pattern.decisions.filter(d => d === PermissionDecision.Deny).length;

				// If 80% or more decisions are the same, suggest a rule
				const consistency = Math.max(allowCount, denyCount) / pattern.count;
				if (consistency >= 0.8) {
					const decision = allowCount > denyCount ? PermissionDecision.Allow : PermissionDecision.Deny;

					suggestedRules.push({
						id: generateUuid(),
						name: `Auto-generated rule for ${operation} on ${extension} files`,
						description: `Based on ${pattern.count} recent ${decision} decisions`,
						operation: operation as PermissionOperation,
						scope: PermissionScope.File,
						decision,
						riskLevel: decision === PermissionDecision.Allow ? RiskLevel.Low : RiskLevel.Medium,
						conditions: [{
							type: ConditionType.FileExtension,
							operator: 'equals',
							value: extension
						}],
						priority: 100,
						enabled: true,
						auditRequired: true,
						createdAt: new Date(),
						modifiedAt: new Date()
					});
				}
			}
		}

		return suggestedRules;
	}

	// Private Methods

	private _createPermissionResult(
		decision: PermissionDecision,
		reason: string,
		startTime: number,
		matchedRule?: PermissionRule
	): PermissionResult {
		return {
			decision,
			matchedRule,
			reason,
			riskLevel: matchedRule?.riskLevel || RiskLevel.Medium,
			requiresConfirmation: decision === PermissionDecision.Prompt,
			evaluationTime: Date.now() - startTime,
			cacheable: decision !== PermissionDecision.Prompt,
			cacheTimeout: this._configuration.cacheTTL
		};
	}

	private _ruleMatches(rule: PermissionRule, context: PermissionContext): boolean {
		// Check operation match
		if (rule.operation !== context.operation) {
			return false;
		}

		// Check scope match (allow broader scopes to match narrower contexts)
		if (!this._scopeMatches(rule.scope, context.scope)) {
			return false;
		}

		// Evaluate all conditions (AND logic)
		return rule.conditions.every(condition => this._evaluateCondition(condition, context));
	}

	private _scopeMatches(ruleScope: PermissionScope, contextScope: PermissionScope): boolean {
		// System scope matches everything
		if (ruleScope === PermissionScope.System) {
			return true;
		}

		// Workspace scope matches workspace, directory, and file
		if (ruleScope === PermissionScope.Workspace &&
			[PermissionScope.Workspace, PermissionScope.Directory, PermissionScope.File].includes(contextScope)) {
			return true;
		}

		// Directory scope matches directory and file
		if (ruleScope === PermissionScope.Directory &&
			[PermissionScope.Directory, PermissionScope.File].includes(contextScope)) {
			return true;
		}

		// File scope only matches file
		return ruleScope === contextScope;
	}

	private _evaluateCondition(condition: RuleCondition, context: PermissionContext): boolean {
		let result = false;

		try {
			switch (condition.type) {
				case ConditionType.FileExtension:
					result = this._evaluateFileExtension(condition, context);
					break;
				case ConditionType.FilePattern:
					result = this._evaluateFilePattern(condition, context);
					break;
				case ConditionType.FilePath:
					result = this._evaluateFilePath(condition, context);
					break;
				case ConditionType.FileSize:
					result = this._evaluateFileSize(condition, context);
					break;
				case ConditionType.WorkspaceRoot:
					result = this._evaluateWorkspaceRoot(condition, context);
					break;
				case ConditionType.TimeOfDay:
					result = this._evaluateTimeOfDay(condition, context);
					break;
				case ConditionType.RecentActivity:
					result = this._evaluateRecentActivity(condition, context);
					break;
				default:
					this._logService.warn(`AutoPermissionService: Unknown condition type: ${condition.type}`);
					result = false;
			}
		} catch (error) {
			this._logService.error(`AutoPermissionService: Error evaluating condition ${condition.type}`, error);
			result = false;
		}

		return condition.negate ? !result : result;
	}

	private _evaluateFileExtension(condition: RuleCondition, context: PermissionContext): boolean {
		const extension = this._getFileExtension(context.uri.path);
		const values = Array.isArray(condition.value) ? condition.value : [condition.value];

		switch (condition.operator) {
			case 'equals':
				return values.includes(extension);
			case 'contains':
				return values.some(v => extension.includes(String(v)));
			default:
				return false;
		}
	}

	private _evaluateFilePattern(condition: RuleCondition, context: PermissionContext): boolean {
		const path = context.uri.path;
		const patterns = Array.isArray(condition.value) ? condition.value : [condition.value];

		switch (condition.operator) {
			case 'matches':
				return patterns.some(pattern => {
					const regex = new RegExp(String(pattern));
					return regex.test(path);
				});
			case 'contains':
				return patterns.some(pattern => path.includes(String(pattern)));
			case 'startsWith':
				return patterns.some(pattern => path.startsWith(String(pattern)));
			case 'endsWith':
				return patterns.some(pattern => path.endsWith(String(pattern)));
			default:
				return false;
		}
	}

	private _evaluateFilePath(condition: RuleCondition, context: PermissionContext): boolean {
		const path = context.uri.path;
		const value = String(condition.value);

		switch (condition.operator) {
			case 'equals':
				return path === value;
			case 'contains':
				return path.includes(value);
			case 'startsWith':
				return path.startsWith(value);
			case 'endsWith':
				return path.endsWith(value);
			case 'matches': {
				const regex = new RegExp(value);
				return regex.test(path);
			}
			default:
				return false;
		}
	}

	private _evaluateFileSize(condition: RuleCondition, context: PermissionContext): boolean {
		// For now, return true as we don't have easy access to file size
		// This would need to be implemented with actual file system access
		return true;
	}

	private _evaluateWorkspaceRoot(condition: RuleCondition, context: PermissionContext): boolean {
		// This would need to be implemented with workspace service integration
		return true;
	}

	private _evaluateTimeOfDay(condition: RuleCondition, context: PermissionContext): boolean {
		const now = new Date();
		const hour = now.getHours();
		const value = Number(condition.value);

		switch (condition.operator) {
			case 'equals':
				return hour === value;
			case 'lessThan':
				return hour < value;
			case 'greaterThan':
				return hour > value;
			case 'between': {
				const [start, end] = Array.isArray(condition.value) ? condition.value : [value, value];
				return hour >= Number(start) && hour <= Number(end);
			}
			default:
				return false;
		}
	}

	private _evaluateRecentActivity(condition: RuleCondition, context: PermissionContext): boolean {
		// Check recent permission decisions for this file/operation
		const recentEntries = this._auditLog
			.filter(entry =>
				entry.context.uri.toString() === context.uri.toString() &&
				entry.context.operation === context.operation &&
				Date.now() - entry.context.timestamp.getTime() < Number(condition.value) * 60000 // value in minutes
			);

		return recentEntries.length > 0;
	}

	private _validateCondition(condition: RuleCondition): string[] {
		const errors: string[] = [];

		if (!Object.values(ConditionType).includes(condition.type)) {
			errors.push(`Invalid condition type: ${condition.type}`);
		}

		if (!condition.operator) {
			errors.push('Condition operator is required');
		}

		if (condition.value === undefined || condition.value === null) {
			errors.push('Condition value is required');
		}

		return errors;
	}

	private _getFileExtension(path: string): string {
		const lastDot = path.lastIndexOf('.');
		return lastDot === -1 ? '' : path.substring(lastDot + 1).toLowerCase();
	}

	private _getCacheKey(context: PermissionContext): string {
		return `${context.operation}-${context.uri.toString()}-${context.requestingTool}`;
	}

	private _cleanupCache(): void {
		const now = Date.now();
		for (const [key, entry] of this._cache) {
			if (now - entry.timestamp > entry.ttl) {
				this._cache.delete(key);
			}
		}
	}

	private _logPermissionDecision(context: PermissionContext, result: PermissionResult, executed: boolean): void {
		const entry: PermissionAuditEntry = {
			id: generateUuid(),
			context,
			result,
			executed
		};

		this._auditLog.push(entry);

		// Limit audit log size
		if (this._auditLog.length > this._configuration.maxAuditEntries) {
			this._auditLog = this._auditLog.slice(-this._configuration.maxAuditEntries);
		}
	}

	private async _createRuleFromContext(context: PermissionContext, decision: PermissionDecision): Promise<void> {
		const activeProfile = this.getActiveProfile();
		if (!activeProfile || activeProfile.isBuiltIn) {
			this._logService.warn('AutoPermissionService: Cannot create rule - no active custom profile');
			return;
		}

		const extension = this._getFileExtension(context.uri.path);
		const rule: Omit<PermissionRule, 'id' | 'createdAt' | 'modifiedAt'> = {
			name: `Auto-created rule for ${context.operation} on ${extension || 'unknown'} files`,
			description: `Created from manual ${decision} decision`,
			operation: context.operation,
			scope: context.scope,
			decision,
			riskLevel: decision === PermissionDecision.Allow ? RiskLevel.Low : RiskLevel.Medium,
			conditions: extension ? [{
				type: ConditionType.FileExtension,
				operator: 'equals',
				value: extension
			}] : [],
			priority: 50,
			enabled: true,
			auditRequired: true
		};

		await this.addRule(activeProfile.id, rule);
	}

	private async _initializeBuiltInProfiles(): Promise<void> {
		// Only create if they don't exist
		const existingProfiles = this.getProfiles();
		const builtInLevels = ['conservative', 'balanced', 'permissive'];

		for (const level of builtInLevels) {
			if (!existingProfiles.some(p => p.securityLevel === level && p.isBuiltIn)) {
				await this._createBuiltInProfile(level as any);
			}
		}

		// Set conservative as active if no profile is active
		if (!this._activeProfileId) {
			const conservativeProfile = this.getProfiles().find(p => p.securityLevel === 'conservative');
			if (conservativeProfile) {
				await this.setActiveProfile(conservativeProfile.id);
			}
		}
	}

	private async _createBuiltInProfile(level: 'conservative' | 'balanced' | 'permissive'): Promise<void> {
		let rules: Omit<PermissionRule, 'id' | 'createdAt' | 'modifiedAt'>[] = [];
		let defaultDecision: PermissionDecision = PermissionDecision.Prompt;

		if (level === 'conservative') {
			defaultDecision = PermissionDecision.Prompt;
			rules = [
				{
					name: 'Allow reading common text files',
					description: 'Allow reading of common safe file types',
					operation: PermissionOperation.Read,
					scope: PermissionScope.File,
					decision: PermissionDecision.Allow,
					riskLevel: RiskLevel.Low,
					conditions: [{
						type: ConditionType.FileExtension,
						operator: 'equals',
						value: ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log']
					}],
					priority: 100,
					enabled: true,
					auditRequired: true
				},
				{
					name: 'Deny write operations on system files',
					description: 'Block write operations on potentially dangerous files',
					operation: PermissionOperation.Write,
					scope: PermissionScope.File,
					decision: PermissionDecision.Deny,
					riskLevel: RiskLevel.Critical,
					conditions: [{
						type: ConditionType.FileExtension,
						operator: 'equals',
						value: ['exe', 'dll', 'sys', 'bat', 'cmd', 'ps1', 'sh']
					}],
					priority: 200,
					enabled: true,
					auditRequired: true
				}
			];
		} else if (level === 'balanced') {
			defaultDecision = PermissionDecision.Prompt;
			rules = [
				{
					name: 'Allow reading common development files',
					description: 'Allow reading of common development and document files',
					operation: PermissionOperation.Read,
					scope: PermissionScope.File,
					decision: PermissionDecision.Allow,
					riskLevel: RiskLevel.Low,
					conditions: [{
						type: ConditionType.FileExtension,
						operator: 'equals',
						value: ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'scss', 'sass']
					}],
					priority: 100,
					enabled: true,
					auditRequired: false
				},
				{
					name: 'Allow writing to common development files',
					description: 'Allow writing to common safe development files',
					operation: PermissionOperation.Write,
					scope: PermissionScope.File,
					decision: PermissionDecision.Allow,
					riskLevel: RiskLevel.Low,
					conditions: [{
						type: ConditionType.FileExtension,
						operator: 'equals',
						value: ['txt', 'md', 'json', 'js', 'ts', 'py', 'html', 'css']
					}],
					priority: 90,
					enabled: true,
					auditRequired: true
				},
				{
					name: 'Deny dangerous operations',
					description: 'Block operations on executable and system files',
					operation: PermissionOperation.Write,
					scope: PermissionScope.File,
					decision: PermissionDecision.Deny,
					riskLevel: RiskLevel.Critical,
					conditions: [{
						type: ConditionType.FileExtension,
						operator: 'equals',
						value: ['exe', 'dll', 'sys', 'bat', 'cmd', 'ps1', 'sh']
					}],
					priority: 200,
					enabled: true,
					auditRequired: true
				}
			];
		} else if (level === 'permissive') {
			defaultDecision = PermissionDecision.Allow;
			rules = [
				{
					name: 'Deny critical system operations',
					description: 'Only block operations on critical system files',
					operation: PermissionOperation.Write,
					scope: PermissionScope.File,
					decision: PermissionDecision.Deny,
					riskLevel: RiskLevel.Critical,
					conditions: [{
						type: ConditionType.FileExtension,
						operator: 'equals',
						value: ['exe', 'dll', 'sys']
					}],
					priority: 200,
					enabled: true,
					auditRequired: true
				}
			];
		}

		const profile: Omit<PermissionProfile, 'id' | 'createdAt' | 'modifiedAt' | 'version'> = {
			name: `${level.charAt(0).toUpperCase() + level.slice(1)} Profile`,
			description: `Built-in ${level} security profile`,
			isBuiltIn: true,
			isActive: false,
			isDefault: level === 'conservative',
			rules: rules as PermissionRule[], // Will be properly typed when rules get IDs
			defaultDecision,
			securityLevel: level
		};

		await this.createProfile(profile);
	}

	private async _saveState(): Promise<void> {
		try {
			const state = {
				profiles: Array.from(this._profiles.entries()),
				activeProfileId: this._activeProfileId,
				auditLog: this._auditLog.slice(-this._configuration.maxAuditEntries), // Limit saved entries
				configuration: this._configuration
			};

			await this._extensionContext.globalState.update('autoPermissionService', state);
		} catch (error) {
			this._logService.error('AutoPermissionService: Failed to save state', error);
		}
	}

	private _loadState(): void {
		try {
			const state = this._extensionContext.globalState.get<{
				profiles: Array<[string, PermissionProfile]>;
				activeProfileId?: string;
				auditLog: PermissionAuditEntry[];
				configuration?: ServiceConfiguration;
			}>('autoPermissionService');

			if (state) {
				this._profiles = new Map(state.profiles || []);
				this._activeProfileId = state.activeProfileId;
				this._auditLog = state.auditLog || [];

				if (state.configuration) {
					this._configuration = { ...this._configuration, ...state.configuration };
				}

				this._logService.info(`AutoPermissionService: Loaded state with ${this._profiles.size} profiles and ${this._auditLog.length} audit entries`);
			}
		} catch (error) {
			this._logService.error('AutoPermissionService: Failed to load state', error);
		}
	}
}