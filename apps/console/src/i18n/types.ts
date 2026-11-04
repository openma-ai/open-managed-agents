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
    budget: string;
    overview: string;
    managedAgents: string;
    dashboard: string;
    agents: string;
    sessions: string;
    deployments: string;
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
    loops: string;
    bonds: string;
  };

  // Login page
  budget: {
    title: string;
    subtitle: string;
    byModel: string;
    bySession: string;
    noSpend: string;
    loadMore: string;
  };

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
    tokensInput: string;
    tokensOutput: string;
    tokensCacheRead: string;
    tokensCacheWrite: string;
    budgetCost: string;
    budgetCap: string;
    budgetUnpriced: string;
    budgetNone: string;
    budgetEdit: string;
    budgetRemove: string;
    budgetInvalid: string;
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
    pricing: string;
    pricingHint: string;
    priceInput: string;
    priceOutput: string;
    priceCacheRead: string;
    priceCacheWrite: string;
    pricingRequired: string;
    pricingInvalid: string;
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

  // Deployments: list, create form and detail
  deployments: {
    invalidCron: string;
    meridiem: string;
    am: string;
    pm: string;
    repositoryMountPlaceholder: string;
    fileMountPlaceholder: string;
    loadFailed: string;
    retry: string;

    subtitle: string;
    createDeployment: string;
    searchPlaceholder: string;
    createdBy: string;
    anyone: string;
    agent: string;
    status: string;
    active: string;
    paused: string;
    archived: string;
    all: string;
    trigger: string;
    manual: string;
    schedule: string;
    emptyTitle: string;
    emptyBody: string;
    noMatching: string;
    tryDifferentFilters: string;
    runNow: string;
    runStarted: string;
    pause: string;
    resume: string;
    archive: string;
    confirmArchive: string;

    newSubtitle: string;
    general: string;
    generalHint: string;
    name: string;
    namePlaceholder: string;
    selectAgent: string;
    manageAgents: string;
    environment: string;
    selectEnvironment: string;
    manageEnvironments: string;
    initialMessage: string;
    initialMessagePlaceholder: string;
    initialMessageHint: string;
    optional: string;
    budget: string;
    budgetHint: string;
    budgetInvalid: string;
    triggerHint: string;
    manualHint: string;
    frequency: string;
    frequencies: {
      every_minute: string;
      hourly: string;
      daily: string;
      weekdays: string;
      weekly: string;
      custom: string;
    };
    timezone: string;
    at: string;
    atMinute: string;
    day: string;
    weekdayNames: string[];
    invalidTime: string;
    editCron: string;
    cronExpression: string;
    cronHint: string;
    nextRuns: string;
    nextRunsHint: string;
    noUpcomingRuns: string;
    resources: string;
    resourcesHint: string;
    vaults: string;
    addVault: string;
    manageVaults: string;
    searchVaults: string;
    noVaults: string;
    removeVault: string;
    sessionResources: string;
    sessionResourcesHint: string;
    addResource: string;
    githubRepository: string;
    file: string;
    memoryStore: string;
    removeResource: string;
    repositoryUrl: string;
    authorizationToken: string;
    checkout: string;
    checkoutNone: string;
    checkoutBranch: string;
    checkoutCommit: string;
    branchName: string;
    commitSha: string;
    mountPath: string;
    selectFile: string;
    manageFiles: string;
    noFiles: string;
    selectMemoryStore: string;
    manageMemoryStores: string;
    access: string;
    readWrite: string;
    readOnly: string;
    instructions: string;
    instructionsPlaceholder: string;
    required: string;
    unsavedTitle: string;
    unsavedBody: string;
    stay: string;
    leave: string;

    notFound: string;
    archivedNotice: string;
    pausedManually: string;
    pausedByError: string;
    properties: string;
    agentVersion: string;
    created: string;
    updated: string;
    lastRun: string;
    upcomingRuns: string;
    none: string;
    runs: string;
    runsEmpty: string;
    runsHint: string;
    run: string;
    session: string;
    result: string;
    runSucceeded: string;
    runFailed: string;
    loadMore: string;
  };

  // Matter: Loops (automations) and Bonds (linked apps)
  matter: {
    notConfigured: string;
    loadFailed: string;
    choose: string;
    enable: string;
    disable: string;
    runNow: string;
    runStarted: string;
    running: string;
    starting: string;
    stopped: string;
    error: string;
    disabled: string;
    lastError: string;
    back: string;
    providers: { feishu: string; gitlab: string; slack: string };
    loops: {
      newLoop: string;
      empty: string;
      emptyBody: string;
      template: string;
      bond: string;
      agent: string;
      newTitle: string;
      editTitle: string;
      confirmDelete: string;
      pickBondFirst: string;
      noResources: string;
      noBond: string;
      mine: string;
      templatesTitle: string;
      use: string;
      enabledLabel: string;
      sectionBondHint: string;
      sectionSession: string;
      sectionTrigger: string;
      sectionTriggerHint: string;
      sectionSessionHint: string;
      environment: string;
      environmentDefault: string;
      environmentHint: string;
      vaults: string;
      vaultsHint: string;
      noVaults: string;
      sectionOptions: string;
      sectionOptionsHint: string;
      notFound: string;
      saved: string;
      searchTemplates: string;
      noTemplates: string;
      suggested: string;
      searchLoops: string;
      noMatch: string;
      viewAllTemplates: string;
      all: string;
    };
    bonds: {
      linkApp: string;
      linkFeishu: string;
      linkGitLab: string;
      linkSlack: string;
      empty: string;
      emptyBody: string;
      app: string;
      provider: string;
      loops: string;
      connected: string;
      setupNeeded: string;
      setupReady: string;
      setupFixes: string;
      setupUnknown: string;
      linkScopes: string;
      linkEvents: string;
      linkBot: string;
      linkPublish: string;
      usedBy: string;
      noLoops: string;
      inUse: string;
      confirmDelete: string;
      scan: string;
      showQr: string;
      openInFeishu: string;
      waiting: string;
      expired: string;
      denied: string;
      linkFailed: string;
      gitlabUrl: string;
      gitlabToken: string;
      otherInstance: string;
      link: string;
      webhookHint: string;
      webhookUrl: string;
      webhookSecret: string;
      done: string;
      sectionInfo: string;
      sectionSetup: string;
      sectionSetupHint: string;
      gitlabHint: string;
      gitlabModeCreate: string;
      gitlabModePaste: string;
      gitlabBotHint: string;
      gitlabProject: string;
      gitlabPreset: string;
      gitlabPresetRead: string;
      gitlabPresetComment: string;
      gitlabExpires: string;
      gitlabUserToken: string;
      slackLinked: string;
      slackSocketOn: string;
      slackRequestUrlHint: string;
      slackIngressHint: string;
      slackAppToken: string;
      slackSigningSecret: string;
      slackBotToken: string;
      slackHint: string;
      createBot: string;
      replaceToken: string;
      replace: string;
      tokenReplaced: string;
      feishuModeScan: string;
      feishuModeExisting: string;
      feishuExistingHint: string;
      feishuAppId: string;
      feishuAppSecret: string;
      feishuBrand: string;
      brandFeishu: string;
      brandLark: string;
      replaceSecret: string;
      secretReplaced: string;
      notFound: string;
      detail: {
        appId: string;
        baseUrl: string;
        username: string;
        webhookUrl: string;
        tokenScopes: string;
        tokenExpiresAt: string;
        teamId: string;
        botUserId: string;
        requestUrl: string;
        socketMode: string;
      };
    };
    /** Template names and descriptions, by template id. */
    templates: Record<string, { name: string; description: string }>;
    /** Config field labels, by field key. */
    fields: Record<string, { title: string; description?: string }>;
    /** Enum option labels, by value. */
    options: Record<string, string>;
    /** The label of `freshness: "thread"`. */
    freshnessThread: string;
    /** Loop configuration problems by code; {field}, {max}, {min}, {options}, {timezone}, {id}, {expected} are filled in. */
    issues: {
      required: string;
      type: string;
      max_length: string;
      min_items: string;
      enum: string;
      schedule_fields: string;
      schedule_invalid: string;
      timezone_unknown: string;
      not_found: string;
      /** Appended when the problem is in one entry of a list: {item} is its position. */
      item: string;
    };
    issueTypes: { string: string; boolean: string; list: string };
  };
}
