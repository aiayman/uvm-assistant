import { UvmType } from '../models/uvmNode';

const UVM_BASE_CLASS_MAP: Record<string, UvmType> = {
  'uvm_test': 'test',
  'uvm_env': 'env',
  'uvm_agent': 'agent',
  'uvm_driver': 'driver',
  'uvm_push_driver': 'driver',
  'uvm_monitor': 'monitor',
  'uvm_scoreboard': 'scoreboard',
  'uvm_sequence': 'sequence',
  'uvm_sequence_base': 'sequence',
  'uvm_sequencer': 'sequencer',
  'uvm_sequencer_base': 'sequencer',
  'uvm_push_sequencer': 'sequencer',
  'uvm_subscriber': 'subscriber',
  'uvm_reg_block': 'reg_block',
  'uvm_reg': 'reg',
  'uvm_reg_sequence': 'reg_sequence',
  'uvm_reg_adapter': 'reg_adapter',
  'uvm_reg_predictor': 'reg_predictor',
  'uvm_component': 'component',
  'uvm_object': 'object',
  'uvm_transaction': 'object',
  'uvm_sequence_item': 'object',
};

/**
 * Classify a UVM base class name to a semantic UVM type.
 * Also handles parameterized base classes like `uvm_driver #(my_txn)`.
 */
export function classifyUvmBase(baseClass: string): UvmType {
  // Strip parameterization: "uvm_driver #(txn)" → "uvm_driver"
  const stripped = baseClass.replace(/\s*#\s*\(.*\)/, '').trim();
  return UVM_BASE_CLASS_MAP[stripped] ?? 'unknown';
}

/** Map of UVM type to the icon filename (without .svg) in resources/ */
export function uvmTypeIcon(uvmType: UvmType): string {
  switch (uvmType) {
    case 'test': return 'uvm-test';
    case 'env': return 'uvm-env';
    case 'agent': return 'uvm-agent';
    case 'driver': return 'uvm-driver';
    case 'monitor': return 'uvm-monitor';
    case 'scoreboard': return 'uvm-scoreboard';
    case 'sequence': return 'uvm-sequence';
    case 'sequencer': return 'uvm-sequencer';
    case 'subscriber': return 'uvm-subscriber';
    case 'reg_block': return 'uvm-reg-block';
    case 'reg': return 'uvm-reg';
    case 'reg_sequence': return 'uvm-reg-sequence';
    case 'reg_adapter': return 'uvm-reg-adapter';
    case 'reg_predictor': return 'uvm-reg-predictor';
    case 'component': return 'uvm-component';
    default: return 'uvm-class';
  }
}
