/**
 * User override types for .uvm-assistant.json config file.
 * Overrides are applied on top of auto-detected results.
 */

/** A user-added component (e.g. a DUT that wasn't auto-detected) */
export interface ComponentOverride {
  name: string;
  role: string;
  filePath: string;
  line?: number;
  /** For DUTs: the instance name in the testbench */
  instanceName?: string;
}

/** A user-added or removed connection */
export interface ConnectionOverride {
  from: string;
  to: string;
  label?: string;
}

/** Full override config stored in .uvm-assistant.json */
export interface OverrideConfig {
  /** Manually added components */
  addedComponents?: ComponentOverride[];
  /** Component names to hide from the diagram */
  removedComponents?: string[];
  /** Reclassify a component: className → newRole */
  roleOverrides?: Record<string, string>;
  /** Manually added connections */
  addedConnections?: ConnectionOverride[];
  /** Connections to remove (matched by from+to) */
  removedConnections?: ConnectionOverride[];
}

/** Row in the mapping table sent to the webview */
export interface MappingComponent {
  name: string;
  role: string;
  filePath: string;
  line: number;
  source: 'auto' | 'override';
}

/** Connection row in the mapping table sent to the webview */
export interface MappingConnection {
  from: string;
  to: string;
  label: string;
  type: 'tlm' | 'virtual_if' | 'inferred' | 'manual';
  source: 'auto' | 'override';
}
