declare module "vite-plugin-node-worker" {
  const plugin: any;
  export default plugin;
}

declare module "*?nodeWorker" {
  const worker: any;
  export default worker;
}

declare module "*?modulePath" {
  const modulePath: string;
  export default modulePath;
}