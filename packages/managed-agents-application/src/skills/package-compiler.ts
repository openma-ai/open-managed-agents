import type { SkillPackageArchive } from "@open-managed-agents/domain/skills";

export interface SkillPackageSourceFile {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface CompileSkillPackage {
  files: SkillPackageSourceFile[];
}

export interface CompiledSkillPackage {
  archive: SkillPackageArchive;
  description: string;
  directory: string;
  name: string;
}

export type CompileSkillPackageResult =
  | { type: "compiled"; package: CompiledSkillPackage }
  | { type: "invalid_request"; message: string };

export interface SkillPackageCompilerPort {
  compile(input: CompileSkillPackage): Promise<CompileSkillPackageResult>;
}
