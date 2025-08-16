/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import { URI } from '../../../util/vs/base/common/uri';

/**
 * Types of operations that can be auto-approved
 */
export const enum PermissionOperation {
	Read = 'read',
	Write = 'write',
	Execute = 'execute',
	Delete = 'delete',
	Create = 'create',
	Analyze = 'analyze',
	Edit = 'edit',
	Search = 'search'
}

/**
 * Scope of permission rules
 */
export const enum PermissionScope {
	File = 'file',
	Directory = 'directory',
	Workspace = 'workspace',
	System = 'system'
}

/**
 * Risk levels for operations
 */
export const enum RiskLevel {
	Low = 'low',
	Medium = 'medium',
	High = 'high',
	Critical = 'critical'
}

/**
 * Condition types for permission rules
 */
export const enum ConditionType {
	FilePattern = 'filePattern',
	FileSize = 'fileSize',
	FilePath = 'filePath',
	FileExtension = 'fileExtension',
	WorkspaceRoot = 'workspaceRoot',
	TimeOfDay = 'timeOfDay',
	UserConfirmation = 'userConfirmation',
	RecentActivity = 'recentActivity'
}

/**
 * Result of permission evaluation
 */
export const enum PermissionDecision {
	Allow = 'allow',
	Deny = 'deny',
	Prompt = 'prompt'
}

/**
 * A condition that must be met for a permission rule to apply
 */
export interface RuleCondition {
	/** Type of condition to evaluate */
	type: ConditionType;

	/** Operator for comparison */
	operator: 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'matches' | 'lessThan' | 'greaterThan' | 'between';

	/** Value(s) to compare against */
	value: string | number | string[] | number[];

	/** Whether this condition should be negated */
	negate?: boolean;

	/** Additional metadata for the condition */
	metadata?: Record<string, any>;
}

/**
 * A rule that defines when and how permissions should be granted
 */
export interface PermissionRule {
	/** Unique identifier for the rule */
	id: string;

	/** Human-readable name for the rule */
	name: string;

	/** Description of what this rule does */
	description: string;

	/** Operation this rule applies to */
	operation: PermissionOperation;

	/** Scope this rule applies to */
	scope: PermissionScope;

	/** Decision to make when rule matches */
	decision: PermissionDecision;

	/** Risk level of this rule */
	riskLevel: RiskLevel;

	/** Conditions that must be met for rule to apply */
	conditions: RuleCondition[];

	/** Priority order (higher numbers processed first) */
	priority: number;

	/** Whether this rule is enabled */
	enabled: boolean;

	/** Custom message to show to user */
	message?: string;

	/** Whether to audit this rule's usage */
	auditRequired: boolean;

	/** When this rule was created */
	createdAt: Date;

	/** When this rule was last modified */
	modifiedAt: Date;

	/** User who created this rule */
	createdBy?: string;
}

/**
 * A collection of permission rules that work together
 */
export interface PermissionProfile {
	/** Unique identifier for the profile */
	id: string;

	/** Human-readable name for the profile */
	name: string;

	/** Description of this profile's purpose */
	description: string;

	/** Whether this is a built-in profile */
	isBuiltIn: boolean;

	/** Whether this profile is currently active */
	isActive: boolean;

	/** Whether this is the default profile */
	isDefault: boolean;

	/** Rules that make up this profile */
	rules: PermissionRule[];

	/** Default decision when no rules match */
	defaultDecision: PermissionDecision;

	/** Overall security level of this profile */
	securityLevel: 'conservative' | 'balanced' | 'permissive' | 'custom';

	/** When this profile was created */
	createdAt: Date;

	/** When this profile was last modified */
	modifiedAt: Date;

	/** User who created this profile */
	createdBy?: string;

	/** Version number for profile changes */
	version: number;
}

/**
 * Context information for permission evaluation
 */
export interface PermissionContext {
	/** File or resource being accessed */
	uri: URI;

	/** Operation being performed */
	operation: PermissionOperation;

	/** Scope of the operation */
	scope: PermissionScope;

	/** User performing the operation */
	userId?: string;

	/** Tool or feature requesting permission */
	requestingTool: string;

	/** Additional context about the request */
	metadata?: Record<string, any>;

	/** Timestamp of the request */
	timestamp: Date;

	/** Whether this is a batch operation */
	isBatchOperation?: boolean;

	/** Number of items in batch if applicable */
	batchSize?: number;

	/** Previous permission decisions for similar requests */
	previousDecisions?: PermissionAuditEntry[];
}

/**
 * Result of evaluating permissions for a request
 */
export interface PermissionResult {
	/** Final decision */
	decision: PermissionDecision;

	/** Rule that made the decision */
	matchedRule?: PermissionRule;

	/** Reason for the decision */
	reason: string;

	/** Risk level of the operation */
	riskLevel: RiskLevel;

	/** Whether user confirmation is required */
	requiresConfirmation: boolean;

	/** Message to display to user */
	message?: string;

	/** Suggested actions for user */
	suggestedActions?: string[];

	/** Time taken to evaluate (for performance monitoring) */
	evaluationTime: number;

	/** Whether this decision should be cached */
	cacheable: boolean;

	/** How long to cache this decision (ms) */
	cacheTimeout?: number;
}

/**
 * Entry in the permission audit log
 */
export interface PermissionAuditEntry {
	/** Unique identifier for this audit entry */
	id: string;

	/** Context of the permission request */
	context: PermissionContext;

	/** Result of the permission evaluation */
	result: PermissionResult;

	/** Whether the operation was ultimately executed */
	executed: boolean;

	/** Any additional notes about the operation */
	notes?: string;

	/** Session identifier */
	sessionId?: string;

	/** IP address of the request (if applicable) */
	ipAddress?: string;
}

/**
 * Statistics about permission usage
 */
export interface PermissionStatistics {
	/** Total number of permission requests */
	totalRequests: number;

	/** Number of requests by decision type */
	decisionCounts: Record<PermissionDecision, number>;

	/** Number of requests by operation type */
	operationCounts: Record<PermissionOperation, number>;

	/** Number of requests by risk level */
	riskLevelCounts: Record<RiskLevel, number>;

	/** Average evaluation time */
	averageEvaluationTime: number;

	/** Most frequently matched rules */
	topRules: Array<{ ruleId: string; count: number }>;

	/** Time period these stats cover */
	periodStart: Date;
	periodEnd: Date;
}

/**
 * Event data for permission changes
 */
export interface PermissionChangeEvent {
	type: 'profileCreated' | 'profileUpdated' | 'profileDeleted' | 'profileActivated' | 'ruleChanged';
	profileId?: string;
	ruleId?: string;
	timestamp: Date;
	userId?: string;
}

/**
 * Event data for permission decisions
 */
export interface PermissionDecisionEvent {
	context: PermissionContext;
	result: PermissionResult;
	timestamp: Date;
}

/**
 * Configuration options for permission evaluation
 */
export interface PermissionEvaluationOptions {
	/** Whether to use cached results if available */
	useCache?: boolean;

	/** Maximum time to spend evaluating (ms) */
	maxEvaluationTime?: number;

	/** Whether to log this evaluation */
	enableAuditLog?: boolean;

	/** Profile to use for evaluation (overrides active profile) */
	profileId?: string;

	/** Whether to skip user confirmation prompts */
	skipUserPrompts?: boolean;
}

/**
 * Service for managing automatic permission approval for file operations
 */
export interface IAutoPermissionService {
	readonly _serviceBrand: undefined;

	// Profile Management

	/**
	 * Create a new permission profile
	 * @param profile The profile to create
	 * @returns Promise resolving to the profile ID
	 */
	createProfile(profile: Omit<PermissionProfile, 'id' | 'createdAt' | 'modifiedAt' | 'version'>): Promise<string>;

	/**
	 * Update an existing permission profile
	 * @param profileId ID of the profile to update
	 * @param updates Partial profile data to update
	 * @returns Promise resolving when update is complete
	 */
	updateProfile(profileId: string, updates: Partial<PermissionProfile>): Promise<void>;

	/**
	 * Delete a permission profile
	 * @param profileId ID of the profile to delete
	 * @returns Promise resolving when deletion is complete
	 */
	deleteProfile(profileId: string): Promise<void>;

	/**
	 * Get all available permission profiles
	 * @returns Array of all profiles
	 */
	getProfiles(): PermissionProfile[];

	/**
	 * Get a specific permission profile
	 * @param profileId ID of the profile to retrieve
	 * @returns The profile or undefined if not found
	 */
	getProfile(profileId: string): PermissionProfile | undefined;

	/**
	 * Set the active permission profile
	 * @param profileId ID of the profile to activate
	 * @returns Promise resolving when profile is activated
	 */
	setActiveProfile(profileId: string): Promise<void>;

	/**
	 * Get the currently active permission profile
	 * @returns The active profile or undefined if none is set
	 */
	getActiveProfile(): PermissionProfile | undefined;

	// Rule Management

	/**
	 * Add a rule to a permission profile
	 * @param profileId ID of the profile to add the rule to
	 * @param rule The rule to add
	 * @returns Promise resolving to the rule ID
	 */
	addRule(profileId: string, rule: Omit<PermissionRule, 'id' | 'createdAt' | 'modifiedAt'>): Promise<string>;

	/**
	 * Update a permission rule
	 * @param profileId ID of the profile containing the rule
	 * @param ruleId ID of the rule to update
	 * @param updates Partial rule data to update
	 * @returns Promise resolving when update is complete
	 */
	updateRule(profileId: string, ruleId: string, updates: Partial<PermissionRule>): Promise<void>;

	/**
	 * Delete a permission rule
	 * @param profileId ID of the profile containing the rule
	 * @param ruleId ID of the rule to delete
	 * @returns Promise resolving when deletion is complete
	 */
	deleteRule(profileId: string, ruleId: string): Promise<void>;

	/**
	 * Get all rules for a profile
	 * @param profileId ID of the profile
	 * @returns Array of rules for the profile
	 */
	getRules(profileId: string): PermissionRule[];

	// Permission Evaluation

	/**
	 * Evaluate whether an operation should be automatically approved
	 * @param context Context information about the permission request
	 * @param options Optional evaluation configuration
	 * @returns Promise resolving to the permission result
	 */
	evaluatePermission(context: PermissionContext, options?: PermissionEvaluationOptions): Promise<PermissionResult>;

	/**
	 * Check if an operation would be auto-approved (without logging)
	 * @param context Context information about the permission request
	 * @param options Optional evaluation configuration
	 * @returns Promise resolving to true if auto-approved
	 */
	wouldAutoApprove(context: PermissionContext, options?: PermissionEvaluationOptions): Promise<boolean>;

	/**
	 * Manually approve an operation and optionally create a rule
	 * @param context Context information about the permission request
	 * @param createRule Whether to create a rule for similar future requests
	 * @returns Promise resolving when approval is processed
	 */
	manuallyApprove(context: PermissionContext, createRule?: boolean): Promise<void>;

	/**
	 * Manually deny an operation and optionally create a rule
	 * @param context Context information about the permission request
	 * @param createRule Whether to create a rule for similar future requests
	 * @returns Promise resolving when denial is processed
	 */
	manuallyDeny(context: PermissionContext, createRule?: boolean): Promise<void>;

	// Audit and Logging

	/**
	 * Get the audit log of permission decisions
	 * @param limit Maximum number of entries to return
	 * @param filter Optional filter criteria
	 * @returns Array of audit entries
	 */
	getAuditLog(limit?: number, filter?: Partial<PermissionAuditEntry>): PermissionAuditEntry[];

	/**
	 * Clear the audit log
	 * @param olderThan Optional date to clear entries older than
	 * @returns Promise resolving when log is cleared
	 */
	clearAuditLog(olderThan?: Date): Promise<void>;

	/**
	 * Export audit log data
	 * @param format Export format ('json' | 'csv')
	 * @returns Promise resolving to exported data
	 */
	exportAuditLog(format: 'json' | 'csv'): Promise<string>;

	/**
	 * Get permission usage statistics
	 * @param timeRange Optional time range for statistics
	 * @returns Statistics about permission usage
	 */
	getStatistics(timeRange?: { start: Date; end: Date }): PermissionStatistics;

	// Configuration

	/**
	 * Get current service configuration
	 * @returns Current configuration object
	 */
	getConfiguration(): {
		enabled: boolean;
		defaultProfile: string;
		auditEnabled: boolean;
		maxAuditEntries: number;
		cacheEnabled: boolean;
		cacheTTL: number;
	};

	/**
	 * Update service configuration
	 * @param config Configuration updates
	 * @returns Promise resolving when configuration is updated
	 */
	updateConfiguration(config: Partial<{
		enabled: boolean;
		defaultProfile: string;
		auditEnabled: boolean;
		maxAuditEntries: number;
		cacheEnabled: boolean;
		cacheTTL: number;
	}>): Promise<void>;

	// Built-in Profiles

	/**
	 * Create built-in permission profiles (Conservative, Balanced, Permissive)
	 * @returns Promise resolving when built-in profiles are created
	 */
	initializeBuiltInProfiles(): Promise<void>;

	/**
	 * Reset a built-in profile to its default configuration
	 * @param profileId ID of the built-in profile to reset
	 * @returns Promise resolving when profile is reset
	 */
	resetBuiltInProfile(profileId: string): Promise<void>;

	// Events

	/**
	 * Fired when permission profiles or rules change
	 */
	readonly onPermissionChange: Event<PermissionChangeEvent>;

	/**
	 * Fired when a permission decision is made
	 */
	readonly onPermissionDecision: Event<PermissionDecisionEvent>;

	/**
	 * Fired when an error occurs during permission evaluation
	 */
	readonly onError: Event<{ error: Error; context?: PermissionContext }>;

	// Utility

	/**
	 * Test a rule against sample data
	 * @param rule The rule to test
	 * @param testCases Array of test contexts
	 * @returns Promise resolving to test results
	 */
	testRule(rule: PermissionRule, testCases: PermissionContext[]): Promise<Array<{
		context: PermissionContext;
		matches: boolean;
		reason: string;
	}>>;

	/**
	 * Validate a permission rule for correctness
	 * @param rule The rule to validate
	 * @returns Validation result with any errors
	 */
	validateRule(rule: PermissionRule): { valid: boolean; errors: string[] };

	/**
	 * Get suggested rules based on user behavior
	 * @param lookbackDays Number of days to analyze
	 * @returns Promise resolving to suggested rules
	 */
	getSuggestedRules(lookbackDays?: number): Promise<PermissionRule[]>;
}

export const IAutoPermissionService = createServiceIdentifier<IAutoPermissionService>('IAutoPermissionService');