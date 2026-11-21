import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum DrawStatus { open = 0,
                         requested = 1,
                         fulfilled = 2,
                         drawn = 3,
                         settled = 4,
                         voided = 5
}

export type Rung = { numbers: bigint;
                     moonball: bigint;
                     q: bigint;
                     qm: bigint;
                     odds: bigint;
                     pick5: bigint;
                     shares: bigint[]
                   };

export type Format = { range: bigint; moonballs: bigint; pick5: bigint };

export type Entry = { kind: bigint;
                      count: bigint;
                      numbers: bigint[];
                      moonball: bigint;
                      sweep: boolean
                    };

export type Payee = { lo: bigint; hi: bigint; share: bigint };

export type Line = { numbers: bigint[]; moonball: bigint };

export type TicketPreimage = { drawId: bigint;
                               entry: Entry;
                               lines: Line[];
                               payees: Payee[];
                               salt: bigint
                             };

export type SealedTicket = { ephemeral: __compactRuntime.JubjubPoint;
                             body: bigint[]
                           };

export type TicketRecord = { commitment: Uint8Array;
                             games: bigint;
                             refundTo: { bytes: Uint8Array };
                             cipher: SealedTicket;
                             refunded: boolean
                           };

export type Draw = { status: DrawStatus;
                     salesClose: bigint;
                     revealDeadline: bigint;
                     drawDeadline: bigint;
                     settleDeadline: bigint;
                     seedCommitment: Uint8Array;
                     seed: Uint8Array;
                     point: __compactRuntime.JubjubPoint;
                     oracleKey: __compactRuntime.JubjubPoint;
                     output: Uint8Array;
                     numbers: bigint[];
                     moonball: bigint;
                     rung: bigint;
                     format: Format;
                     carried: bigint;
                     fee: bigint;
                     treasuryFee: bigint;
                     overflow: bigint;
                     refill: bigint;
                     prizes: bigint[];
                     final: boolean;
                     mustBeWon: boolean;
                     finalShare: bigint
                   };

export type Progress = { next: bigint; winners: bigint[] };

export type Entitlement = { drawId: bigint;
                            games: bigint[];
                            payees: Payee[];
                            paid: boolean
                          };

export type NextDraw = { salesClose: bigint;
                         seedCommitment: Uint8Array;
                         final: boolean
                       };

export enum SyndicateStatus { filling = 0, funded = 1 }

export type Syndicate = { drawId: bigint;
                          status: SyndicateStatus;
                          creator: Uint8Array;
                          sharePrice: bigint;
                          totalShares: bigint;
                          sold: bigint;
                          games: bigint;
                          bought: bigint;
                          joinDeadline: bigint;
                          members: bigint
                        };

export type Member = { payTo: { bytes: Uint8Array };
                       shares: bigint;
                       refunded: bigint
                     };

export type Numbers = { main: bigint[]; moonball: bigint };

export type Witnesses<PS> = {
  splitByte(context: __compactRuntime.WitnessContext<Ledger, PS>, x_0: bigint): [PS, [bigint,
                                                                                      bigint]];
  divMod16(context: __compactRuntime.WitnessContext<Ledger, PS>,
           v_0: bigint,
           m_0: bigint): [PS, [bigint, bigint]];
  sortSeven(context: __compactRuntime.WitnessContext<Ledger, PS>, v_0: bigint[]): [PS, bigint[]];
  newTickets(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, TicketPreimage[]];
  sealingRandomnessFor(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint[]];
  settlementBatch(context: __compactRuntime.WitnessContext<Ledger, PS>,
                  drawId_0: bigint,
                  first_0: bigint): [PS, TicketPreimage[]];
  oracleSecretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  organiserSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  divModWide(context: __compactRuntime.WitnessContext<Ledger, PS>,
             n_0: bigint,
             d_0: bigint): [PS, [bigint, bigint]];
  syndicateSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  acceptOracleKey(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  proposeOracleKey(context: __compactRuntime.CircuitContext<PS>,
                   key_0: __compactRuntime.JubjubPoint,
                   now_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  changeOrganiser(context: __compactRuntime.CircuitContext<PS>,
                  commitment_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  buyTickets(context: __compactRuntime.CircuitContext<PS>,
             count_0: bigint,
             refundTo_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  requestDraw(context: __compactRuntime.CircuitContext<PS>,
              n_0: bigint,
              seed_0: Uint8Array,
              next_0: { is_some: boolean, value: NextDraw }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  fulfilDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  computeNumbers(context: __compactRuntime.CircuitContext<PS>,
                 n_0: bigint,
                 now_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Numbers>>;
  settleBatch(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  finaliseDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  payEntitlement(context: __compactRuntime.CircuitContext<PS>, id_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  createSyndicate(context: __compactRuntime.CircuitContext<PS>,
                  drawId_0: bigint,
                  creatorCommitment_0: Uint8Array,
                  sharePrice_0: bigint,
                  totalShares_0: bigint,
                  games_0: bigint,
                  joinDeadline_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  joinSyndicate(context: __compactRuntime.CircuitContext<PS>,
                syndicate_0: bigint,
                shares_0: bigint,
                payTo_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  buySyndicateTickets(context: __compactRuntime.CircuitContext<PS>,
                      syndicate_0: bigint,
                      count_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  paySyndicateMember(context: __compactRuntime.CircuitContext<PS>,
                     entitlement_0: Uint8Array,
                     payee_0: bigint,
                     member_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  refundSyndicate(context: __compactRuntime.CircuitContext<PS>,
                  syndicate_0: bigint,
                  member_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  voidDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  refundTicket(context: __compactRuntime.CircuitContext<PS>,
               n_0: bigint,
               index_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  acceptOracleKey(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  proposeOracleKey(context: __compactRuntime.CircuitContext<PS>,
                   key_0: __compactRuntime.JubjubPoint,
                   now_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  changeOrganiser(context: __compactRuntime.CircuitContext<PS>,
                  commitment_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  buyTickets(context: __compactRuntime.CircuitContext<PS>,
             count_0: bigint,
             refundTo_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  requestDraw(context: __compactRuntime.CircuitContext<PS>,
              n_0: bigint,
              seed_0: Uint8Array,
              next_0: { is_some: boolean, value: NextDraw }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  fulfilDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  computeNumbers(context: __compactRuntime.CircuitContext<PS>,
                 n_0: bigint,
                 now_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Numbers>>;
  settleBatch(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  finaliseDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  payEntitlement(context: __compactRuntime.CircuitContext<PS>, id_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  createSyndicate(context: __compactRuntime.CircuitContext<PS>,
                  drawId_0: bigint,
                  creatorCommitment_0: Uint8Array,
                  sharePrice_0: bigint,
                  totalShares_0: bigint,
                  games_0: bigint,
                  joinDeadline_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  joinSyndicate(context: __compactRuntime.CircuitContext<PS>,
                syndicate_0: bigint,
                shares_0: bigint,
                payTo_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  buySyndicateTickets(context: __compactRuntime.CircuitContext<PS>,
                      syndicate_0: bigint,
                      count_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  paySyndicateMember(context: __compactRuntime.CircuitContext<PS>,
                     entitlement_0: Uint8Array,
                     payee_0: bigint,
                     member_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  refundSyndicate(context: __compactRuntime.CircuitContext<PS>,
                  syndicate_0: bigint,
                  member_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  voidDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  refundTicket(context: __compactRuntime.CircuitContext<PS>,
               n_0: bigint,
               index_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
  maxTickets(): bigint;
  batchSize(): bigint;
  maxNumbers(): bigint;
  maxLines(): bigint;
  ticketGames(t_0: TicketPreimage, f_0: Format): bigint;
  ticketDivisions(t_0: TicketPreimage,
                  numbers_0: bigint[],
                  moonball_0: bigint,
                  f_0: Format): bigint[];
  organiserCommitmentOf(secret_0: Uint8Array): Uint8Array;
  syndicateCommitmentOf(secret_0: Uint8Array): Uint8Array;
  syndicateMark(): bigint;
  syndicatePayees(id_0: bigint): Payee[];
  memberKey(syndicate_0: bigint, index_0: bigint): bigint;
  memberPaymentId(entitlement_0: Uint8Array, payee_0: bigint, member_0: bigint): Uint8Array;
  ticketCommitment(deployment_0: { bytes: Uint8Array }, t_0: TicketPreimage): Uint8Array;
  entitlementId(commitment_0: Uint8Array, salt_0: bigint): Uint8Array;
  drawAlpha(deployment_0: { bytes: Uint8Array },
            drawId_0: bigint,
            seed_0: Uint8Array): Uint8Array;
  ticketKey(drawId_0: bigint, index_0: bigint): bigint;
  gamesIn(e_0: Entry, f_0: Format): bigint;
  validTicket(t_0: TicketPreimage, f_0: Format): boolean;
  gamesByDivision(e_0: Entry,
                  numbers_0: bigint[],
                  moonball_0: bigint,
                  f_0: Format): bigint[];
  addressOf(p_0: Payee): { bytes: Uint8Array };
  sealTicket(key_0: __compactRuntime.JubjubPoint,
             r_0: bigint,
             t_0: TicketPreimage): SealedTicket;
  openTicket(secret_0: bigint, drawId_0: bigint, s_0: SealedTicket): TicketPreimage;
  settlementPublicKey(secret_0: bigint): __compactRuntime.JubjubPoint;
}

export type Circuits<PS> = {
  maxTickets(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  batchSize(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  maxNumbers(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  maxLines(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  ticketGames(context: __compactRuntime.CircuitContext<PS>,
              t_0: TicketPreimage,
              f_0: Format): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  ticketDivisions(context: __compactRuntime.CircuitContext<PS>,
                  t_0: TicketPreimage,
                  numbers_0: bigint[],
                  moonball_0: bigint,
                  f_0: Format): Promise<__compactRuntime.CircuitResults<PS, bigint[]>>;
  organiserCommitmentOf(context: __compactRuntime.CircuitContext<PS>,
                        secret_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  syndicateCommitmentOf(context: __compactRuntime.CircuitContext<PS>,
                        secret_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  syndicateMark(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  syndicatePayees(context: __compactRuntime.CircuitContext<PS>, id_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Payee[]>>;
  memberKey(context: __compactRuntime.CircuitContext<PS>,
            syndicate_0: bigint,
            index_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  memberPaymentId(context: __compactRuntime.CircuitContext<PS>,
                  entitlement_0: Uint8Array,
                  payee_0: bigint,
                  member_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  ticketCommitment(context: __compactRuntime.CircuitContext<PS>,
                   deployment_0: { bytes: Uint8Array },
                   t_0: TicketPreimage): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  entitlementId(context: __compactRuntime.CircuitContext<PS>,
                commitment_0: Uint8Array,
                salt_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  drawAlpha(context: __compactRuntime.CircuitContext<PS>,
            deployment_0: { bytes: Uint8Array },
            drawId_0: bigint,
            seed_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  ticketKey(context: __compactRuntime.CircuitContext<PS>,
            drawId_0: bigint,
            index_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  gamesIn(context: __compactRuntime.CircuitContext<PS>, e_0: Entry, f_0: Format): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  validTicket(context: __compactRuntime.CircuitContext<PS>,
              t_0: TicketPreimage,
              f_0: Format): Promise<__compactRuntime.CircuitResults<PS, boolean>>;
  gamesByDivision(context: __compactRuntime.CircuitContext<PS>,
                  e_0: Entry,
                  numbers_0: bigint[],
                  moonball_0: bigint,
                  f_0: Format): Promise<__compactRuntime.CircuitResults<PS, bigint[]>>;
  addressOf(context: __compactRuntime.CircuitContext<PS>, p_0: Payee): Promise<__compactRuntime.CircuitResults<PS, { bytes: Uint8Array
                                                                                                                   }>>;
  sealTicket(context: __compactRuntime.CircuitContext<PS>,
             key_0: __compactRuntime.JubjubPoint,
             r_0: bigint,
             t_0: TicketPreimage): Promise<__compactRuntime.CircuitResults<PS, SealedTicket>>;
  openTicket(context: __compactRuntime.CircuitContext<PS>,
             secret_0: bigint,
             drawId_0: bigint,
             s_0: SealedTicket): Promise<__compactRuntime.CircuitResults<PS, TicketPreimage>>;
  settlementPublicKey(context: __compactRuntime.CircuitContext<PS>,
                      secret_0: bigint): Promise<__compactRuntime.CircuitResults<PS, __compactRuntime.JubjubPoint>>;
  acceptOracleKey(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  proposeOracleKey(context: __compactRuntime.CircuitContext<PS>,
                   key_0: __compactRuntime.JubjubPoint,
                   now_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  changeOrganiser(context: __compactRuntime.CircuitContext<PS>,
                  commitment_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  buyTickets(context: __compactRuntime.CircuitContext<PS>,
             count_0: bigint,
             refundTo_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  requestDraw(context: __compactRuntime.CircuitContext<PS>,
              n_0: bigint,
              seed_0: Uint8Array,
              next_0: { is_some: boolean, value: NextDraw }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  fulfilDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  computeNumbers(context: __compactRuntime.CircuitContext<PS>,
                 n_0: bigint,
                 now_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Numbers>>;
  settleBatch(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  finaliseDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  payEntitlement(context: __compactRuntime.CircuitContext<PS>, id_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  createSyndicate(context: __compactRuntime.CircuitContext<PS>,
                  drawId_0: bigint,
                  creatorCommitment_0: Uint8Array,
                  sharePrice_0: bigint,
                  totalShares_0: bigint,
                  games_0: bigint,
                  joinDeadline_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  joinSyndicate(context: __compactRuntime.CircuitContext<PS>,
                syndicate_0: bigint,
                shares_0: bigint,
                payTo_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  buySyndicateTickets(context: __compactRuntime.CircuitContext<PS>,
                      syndicate_0: bigint,
                      count_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  paySyndicateMember(context: __compactRuntime.CircuitContext<PS>,
                     entitlement_0: Uint8Array,
                     payee_0: bigint,
                     member_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  refundSyndicate(context: __compactRuntime.CircuitContext<PS>,
                  syndicate_0: bigint,
                  member_0: bigint): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  voidDraw(context: __compactRuntime.CircuitContext<PS>, n_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  refundTicket(context: __compactRuntime.CircuitContext<PS>,
               n_0: bigint,
               index_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
  draws: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): Draw;
    [Symbol.iterator](): Iterator<[bigint, Draw]>
  };
  readonly lastDraw: bigint;
  ticketCount: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): bigint;
    [Symbol.iterator](): Iterator<[bigint, bigint]>
  };
  gamesSold: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): bigint;
    [Symbol.iterator](): Iterator<[bigint, bigint]>
  };
  tickets: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): TicketRecord;
    [Symbol.iterator](): Iterator<[bigint, TicketRecord]>
  };
  ticketCommitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  progress: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): Progress;
    [Symbol.iterator](): Iterator<[bigint, Progress]>
  };
  entitlements: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Entitlement;
    [Symbol.iterator](): Iterator<[Uint8Array, Entitlement]>
  };
  usedCommitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  readonly carry: bigint;
  readonly ended: boolean;
  syndicates: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): Syndicate;
    [Symbol.iterator](): Iterator<[bigint, Syndicate]>
  };
  readonly lastSyndicate: bigint;
  members: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): Member;
    [Symbol.iterator](): Iterator<[bigint, Member]>
  };
  syndicatePots: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint[];
    [Symbol.iterator](): Iterator<[Uint8Array, bigint[]]>
  };
  memberPayments: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  readonly ladder: Rung[];
  readonly rungCount: bigint;
  readonly rung: bigint;
  readonly aim: bigint;
  readonly targetDraws: bigint;
  readonly retargetEvery: bigint;
  readonly windowDraws: bigint;
  readonly windowGames: bigint;
  readonly floor: bigint;
  readonly floorPerGame: bigint;
  readonly ceilingPerCombination: bigint;
  readonly treasury: { bytes: Uint8Array };
  readonly treasuryAddress: { bytes: Uint8Array };
  readonly treasuryPerGame: bigint;
  readonly rollovers: bigint;
  readonly oracleKey: __compactRuntime.JubjubPoint;
  readonly oracleKeyReady: boolean;
  readonly proposedOracleKey: { is_some: boolean,
                                value: __compactRuntime.JubjubPoint
                              };
  readonly oracleKeyChangeAt: bigint;
  readonly oracleKeyApproved: boolean;
  readonly oracleKeyDelay: bigint;
  readonly organiser: Uint8Array;
  readonly proposedOrganiser: { is_some: boolean, value: Uint8Array };
  readonly backupOrganiser: Uint8Array;
  readonly settlementKey: __compactRuntime.JubjubPoint;
  readonly operator: { bytes: Uint8Array };
  readonly feePerGame: bigint;
  readonly ticketPrice: bigint;
  readonly minSales: bigint;
  readonly maxSales: bigint;
  readonly revealWindow: bigint;
  readonly drawWindow: bigint;
  readonly settleWindow: bigint;
  readonly maxTicketsPerDraw: bigint;
  readonly finalSales: bigint;
  readonly mustBeWonAfter: bigint;
}

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               key_0: __compactRuntime.JubjubPoint,
               organiserCommitment_0: Uint8Array,
               backupCommitment_0: Uint8Array,
               sealingKey_0: __compactRuntime.JubjubPoint,
               operatorAddress_0: { bytes: Uint8Array },
               fee_0: bigint,
               price_0: bigint,
               salesMin_0: bigint,
               salesMax_0: bigint,
               reveal_0: bigint,
               draw_0: bigint,
               settle_0: bigint,
               ticketLimit_0: bigint,
               finalNotice_0: bigint,
               rolloverCap_0: bigint,
               formats_0: Rung[],
               formatCount_0: bigint,
               startRung_0: bigint,
               target_0: bigint,
               every_0: bigint,
               floor0_0: bigint,
               floorPer_0: bigint,
               ceiling_0: bigint,
               treasuryContract_0: { bytes: Uint8Array },
               treasuryAddr_0: { bytes: Uint8Array },
               treasuryFee_0: bigint): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
export declare const circuitSignatures: __compactRuntime.CircuitSignatures;
export declare const declaredInterfaces: __compactRuntime.DeclaredInterfaces;
