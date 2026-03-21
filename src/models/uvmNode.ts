export type UvmType =
  | 'test'
  | 'env'
  | 'agent'
  | 'driver'
  | 'monitor'
  | 'scoreboard'
  | 'sequence'
  | 'sequencer'
  | 'component'
  | 'object'
  | 'unknown';

export interface UvmNode {
  className: string;
  baseClass: string;
  uvmType: UvmType;
  filePath: string;
  line: number;
  fields: UvmField[];
  children: UvmNode[];
}

export interface UvmField {
  typeName: string;
  fieldName: string;
  line: number;
}

/** Flattened parse result before hierarchy is built */
export interface UvmClassInfo {
  className: string;
  baseClass: string;
  uvmType: UvmType;
  filePath: string;
  line: number;
  fields: UvmField[];
}
