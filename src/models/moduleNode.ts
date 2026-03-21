export interface ModuleNode {
  name: string;
  filePath: string;
  line: number;
  ports: PortInfo[];
  params: ParamInfo[];
  instances: ModuleInstance[];
}

export interface PortInfo {
  name: string;
  direction: 'input' | 'output' | 'inout' | 'unknown';
  width?: string;
}

export interface ParamInfo {
  name: string;
  defaultValue?: string;
}

export interface ModuleInstance {
  moduleName: string;
  instanceName: string;
  filePath: string;
  line: number;
}
