/**
 * The CLI specs a `cap_cli` credential (OpenMA extension) may name. The
 * composition root backs this with the CLI Auth Protocol registry so the
 * application never keeps its own copy of the CLI ids.
 */
export interface CredentialCliCatalogPort {
  has(cliId: string): boolean;
}
