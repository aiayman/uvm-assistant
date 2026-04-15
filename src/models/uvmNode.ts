export type UvmType =
  | 'test'
  | 'env'
  | 'agent'
  | 'driver'
  | 'monitor'
  | 'scoreboard'
  | 'sequence'
  | 'sequencer'
  | 'reg_block'
  | 'reg'
  | 'reg_sequence'
  | 'reg_adapter'
  | 'reg_predictor'
  | 'subscriber'
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
  /** 1-based line number of the .connect() call in the source file */
  line?: number;
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
  virtualIfs: string[];
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
  /** Virtual interface type names used by this class (e.g. "spi_m_interface") */
  virtualIfs: string[];
}

/** DUT module detected from testbench top */
export interface DutInfo {
  moduleName: string;
  instanceName: string;
  filePath: string;
  line: number;
}

/** A distinct testbench project within the workspace */
export interface TestbenchProject {
  /** Human-readable name derived from the directory */
  name: string;
  /** Root directory path for this project */
  rootDir: string;
  /** UVM class tree roots scoped to this project */
  uvmRoots: UvmNode[];
  /** DUT modules scoped to this project */
  duts: DutInfo[];
}
