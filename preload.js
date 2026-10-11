const { contextBridge, ipcRenderer } = require('electron');

contractBridgeSafe();
function contractBridgeSafe() {
  contextBridge.exposeInMainWorld('win', {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    openExternal: (url) => ipcRenderer.invoke('win:openExternal', url)
  });

  contextBridge.exposeInMainWorld('mc', {
    getVersions: () => ipcRenderer.invoke('core:getVersions'),
    getInstalled: () => ipcRenderer.invoke('core:getInstalled'),
    addInstall: (entry) => ipcRenderer.invoke('core:addInstall', entry),
    removeInstall: (id) => ipcRenderer.invoke('core:removeInstall', id),
    openFolder: (id) => ipcRenderer.invoke('core:openFolder', id),
    browseSkin: () => ipcRenderer.invoke('core:browseSkin'),
    browseCape: () => ipcRenderer.invoke('core:browseCape'),
    setActiveSkin: (payload) => ipcRenderer.invoke('core:setActiveSkin', payload),
    defaultSkin: () => ipcRenderer.invoke('core:defaultSkin'),
    getSettings: () => ipcRenderer.invoke('core:getSettings'),
    saveSettings: (s) => ipcRenderer.invoke('core:saveSettings', s),
    browseDir: () => ipcRenderer.invoke('core:browseDir'),
    browseJava: () => ipcRenderer.invoke('core:browseJava'),
    browseJar: () => ipcRenderer.invoke('core:browseJar'),
    install: (id) => ipcRenderer.invoke('core:install', id),
    launch: (opts) => ipcRenderer.invoke('core:launch', opts),
    pauseDownload: () => ipcRenderer.invoke('core:pauseDownload'),
    cancelDownload: () => ipcRenderer.invoke('core:cancelDownload'),
    bedrockDetect: () => ipcRenderer.invoke('bedrock:detect'),
    bedrockPlay: (preview) => ipcRenderer.invoke('bedrock:play', preview),
    bedrockFolder: (preview) => ipcRenderer.invoke('bedrock:folder', preview),
    bedrockRemove: () => ipcRenderer.invoke('bedrock:remove'),
    onProgress: (cb) => ipcRenderer.on('core:progress', (e, p) => cb(p)),
    onGameLog: (cb) => ipcRenderer.on('core:gamelog', (e, l) => cb(l))
  });
}
