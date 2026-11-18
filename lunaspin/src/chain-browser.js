// Browser bundle entry: exposes the chain check as window.LunaSpinChain (built to dist/lunaspin-chain.js).
// It needs dist/lunaspin-chain.wasm (Midnight's on-chain runtime) beside it: pass its address to init().
export * from './chain.js';
