declare module 'idb-keyval' {
  export type Store = unknown
  export function createStore(dbName: string, storeName: string): Store
  export function get<T = unknown>(key: string, store?: Store): Promise<T>
  export function set<T = unknown>(key: string, value: T, store?: Store): Promise<void>
  export function del(key: string, store?: Store): Promise<void>
}
