/**
 * Supported locales for the console UI.
 * Currently only English (default) and Simplified Chinese are implemented.
 * Add new locales here and create corresponding dictionary files.
 */
export type Locale = "en" | "zh-CN";

/**
 * All translatable message keys used across the console.
 * Organized by component/feature area for maintainability.
 */
export interface Messages {
  // Common / shared
  common: {
    loading: string;
    cancel: string;
    create: string;
    edit: string;
    save: string;
    saveChanges: string;
    saving: string;
    creating: string;
    rename: string;
    reset: string;
    delete: string;
    archive: string;
    unarchive: string;
    actions: string;
    search: string;
    status: string;
    name: string;
    description: string;
    created: string;
    id: string;
    model: string;
    active: string;
    archived: string;
    all: string;
    idle: string;
    running: string;
    terminated: string;
    rescheduling: string;
    copied: string;
    viewAll: string;
    nothingHereYet: string;
    loadingMore: string;
    columns: string;
    visibleColumns: string;
    nameRequired: string;
  };

  // Sidebar navigation
  nav: {
    overview: string;
    managedAgents: string;
    dashboard: string;
    agents: string;
    sessions: string;
    files: string;
    evalRuns: string;
    infrastructure: string;
    environments: string;
    credentialVaults: string;
    configuration: string;
    skills: string;
    memoryStores: string;
    modelCards: string;
    apiKeys: string;
    localRuntimes: string;
    integrations: string;
  };

  // Login page
  login: {
    welcomeBack: string;
    createAccount: string;
    signInWithEmailCode: string;
    verifyEmail: string;
    enterCode: string;
    resetPassword: string;
    resetYourPassword: string;
    signInToWorkspace: string;
    getStarted: string;
    sendCodeToEmail: string;
    codeSentTo: string;
    sendResetCode: string;
    enterCodeSent: string;
    email: string;
    password: string;
    newPassword: string;
    verificationCode: string;
    yourName: string;
    minChars: string;
    continueWithGoogle: string;
    or: string;
    signIn: string;
    signUp: string;
    sendCode: string;
    sendResetCodeBtn: string;
    verify: string;
    forgotPassword: string;
    noAccount: string;
    haveAccount: string;
    rememberPassword: string;
    didntReceiveCode: string;
    resend: string;
    goBack: string;
    passwordResetSuccess: string;
    authFailed: string;
    botChallengeTimeout: string;
  };

  // Dashboard
  dashboard: {
    getStarted: string;
    handPlatformToAgent: string;
    installCli: string;
    installCliDesc: string;
    mintApiKey: string;
    mintApiKeyDesc: string;
    generateApiKey: string;
    handItReins: string;
    handItReinsDesc: string;
    recentSessions: string;
    noSessionsYet: string;
    visitSessionsPage: string;
    title: string;
    agent: string;
    untitled: string;
  };

  // Command palette
  command: {
    title: string;
    description: string;
    jumpTo: string;
    noMatches: string;
  };

  // User profile menu
  profile: {
    accountMenu: string;
    documentation: string;
    theme: string;
    light: string;
    dark: string;
    system: string;
    signOut: string;
    switchWorkspace: string;
    createWorkspace: string;
    createWorkspaceDesc: string;
    workspaceName: string;
    workspacePlaceholder: string;
    creating: string;
  };

  // Agents list
  agents: {
    newAgent: string;
    editAgent: string;
    newAgentTitle: string;
    editAgentTitle: string;
    createAgent: string;
    editingVersion: string;
    searchAgents: string;
    noMatchingAgents: string;
    noAgentsYet: string;
    createFirstAgent: string;
    getStartedGuide: string;
    tryDifferentSearch: string;
    archiveAgent: string;
    deleteAgent: string;
    confirmDelete: string;
  };

  // Sessions list
  sessions: {
    newSession: string;
    searchSessions: string;
    noMatchingSessions: string;
    noSessionsYet: string;
    editTitle: string;
    untitledSession: string;
    sessionTitle: string;
  };

  // Vaults list
  vaults: {
    newVault: string;
    searchVaults: string;
    noMatchingVaults: string;
    noVaultsYet: string;
    renameVault: string;
    editCredential: string;
    displayName: string;
    newToken: string;
    newTokenOptional: string;
    leaveBlankKeepToken: string;
    oauthEditHint: string;
  };

  // Environments list
  environments: {
    newEnvironment: string;
    searchEnvironments: string;
    noMatchingEnvironments: string;
    noEnvironmentsYet: string;
  };

  // Files list
  files: {
    uploadFile: string;
    searchFiles: string;
    noMatchingFiles: string;
    noFilesYet: string;
  };

  // Skills list
  skills: {
    newSkill: string;
    searchSkills: string;
    noMatchingSkills: string;
    noSkillsYet: string;
  };

  // Model cards list
  modelCards: {
    newModelCard: string;
    searchModelCards: string;
    noMatchingModelCards: string;
    noModelCardsYet: string;
  };

  // API keys list
  apiKeys: {
    newApiKey: string;
    noApiKeysYet: string;
    revokeKey: string;
    confirmRevoke: string;
    untitledKey: string;
  };

  // Eval runs
  evals: {
    newEvalRun: string;
    searchEvalRuns: string;
    noMatchingEvalRuns: string;
    noEvalRunsYet: string;
  };

  // Memory stores
  memory: {
    newMemoryStore: string;
    searchMemoryStores: string;
    noMatchingMemoryStores: string;
    noMemoryStoresYet: string;
    mountPathHint: string;
    settingsArchiveHint: string;
  };

  // Runtimes
  runtimes: {
    connectRuntime: string;
    searchRuntimes: string;
    noMatchingRuntimes: string;
    noRuntimesYet: string;
  };
}
