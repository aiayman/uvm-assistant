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

export type TlmPortKind =
  | 'analysis_port'
  | 'analysis_export'
  | 'analysis_imp'
  | 'blocking_put_port'
  | 'blocking_get_port'
  | 'seq_item_port'
  | 'seq_item_export';

export interface TlmPort {
  kind: TlmPortKind;
  paramType: string;
  fieldName: string;
}

export interface TlmConnection {
  /** e.g. "drv.seq_item_port" */
  from: string;
  /** e.g. "seqr.seq_item_export" */
  to: string;
}

export interface UvmNode {
  className: string;
  baseClass: string;
  uvmType: UvmType;
  filePath: string;
  line: number;
  fields: UvmField[];
  children: UvmNode[];
  tlmPorts: TlmPort[];
  connections: TlmConnection[];
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
  tlmPorts: TlmPort[];
  connections: TlmConnection[];
}
