// React Native globals we rely on without pulling RN types in.
declare const __DEV__: boolean;

// CommonJS require — used for optional peer-dep detection. We avoid pulling
// @types/node into a tiny RN SDK just for one symbol.
declare function require(name: string): unknown;
