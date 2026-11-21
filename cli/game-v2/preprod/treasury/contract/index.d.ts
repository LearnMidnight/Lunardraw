import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  binderSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  deposit(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  bind(context: __compactRuntime.CircuitContext<PS>,
       gameAddress_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  release(context: __compactRuntime.CircuitContext<PS>,
          request_0: bigint,
          incoming_0: bigint,
          need_0: bigint,
          extra_0: bigint,
          reserve_0: bigint,
          ending_0: boolean): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type ProvableCircuits<PS> = {
  deposit(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  bind(context: __compactRuntime.CircuitContext<PS>,
       gameAddress_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  release(context: __compactRuntime.CircuitContext<PS>,
          request_0: bigint,
          incoming_0: bigint,
          need_0: bigint,
          extra_0: bigint,
          reserve_0: bigint,
          ending_0: boolean): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type PureCircuits = {
  binderCommitmentOf(secret_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  binderCommitmentOf(context: __compactRuntime.CircuitContext<PS>,
                     secret_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  deposit(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  bind(context: __compactRuntime.CircuitContext<PS>,
       gameAddress_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  release(context: __compactRuntime.CircuitContext<PS>,
          request_0: bigint,
          incoming_0: bigint,
          need_0: bigint,
          extra_0: bigint,
          reserve_0: bigint,
          ending_0: boolean): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type Ledger = {
  readonly game: { bytes: Uint8Array };
  readonly bound: boolean;
  readonly gameEnded: boolean;
  readonly nextRequest: bigint;
  readonly totalReleased: bigint;
  readonly binder: Uint8Array;
}

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               binderCommitment_0: Uint8Array): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
export declare const circuitSignatures: __compactRuntime.CircuitSignatures;
export declare const declaredInterfaces: __compactRuntime.DeclaredInterfaces;
