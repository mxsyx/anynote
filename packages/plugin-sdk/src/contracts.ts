export interface NoteSnapshot {
  id: string;
  title: string;
  body: string;
  revision: number;
  head_revision_id: string;
  tags: string[];
  note_type: string;
}
export interface ImageInput {
  id: string;
  expectedRevision: number;
  data: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  name: string;
}
export interface AnynoteAPI {
  notes: {
    get(id: string): Promise<NoteSnapshot>;
    create(input: {
      title: string;
      body?: string;
      parentId?: string | null;
    }): Promise<NoteSnapshot>;
    applyPatch(input: {
      id: string;
      expectedRevision: number;
      body: string;
      operationId: string;
    }): Promise<NoteSnapshot>;
  };
  search: { query(query: string): Promise<NoteSnapshot[]> };
  assets: {
    read(input: {
      id: string;
      noteId: string;
      revisionId?: string;
    }): Promise<{ data: string; mime: string; hash: string }>;
    addImage(input: ImageInput): Promise<NoteSnapshot>;
  };
  settings: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<boolean>;
  };
}

export interface ExtensionContext {
  api: AnynoteAPI;
  registerCommand: (
    id: string,
    handler: (input: unknown) => unknown,
  ) => () => unknown;
}
