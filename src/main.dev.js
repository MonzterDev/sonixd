/* eslint global-require: off, no-console: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `yarn build` or `yarn build:main`, this file is compiled to
 * `./src/main.prod.js` using webpack. This gives us some performance wins.
 */
import 'core-js/stable';
import 'regenerator-runtime/runtime';
import Player from 'mpris-service';
import path from 'path';
import { ipcMain, app, BrowserWindow, shell, globalShortcut, Menu, Tray, dialog } from 'electron';
import electronLocalshortcut from 'electron-localshortcut';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { configureStore } from '@reduxjs/toolkit';
import { forwardToRenderer, triggerAlias, replayActionMain } from 'electron-redux';
import playerReducer from './redux/playerSlice';
import playQueueReducer, { toggleShuffle, toggleRepeat, setVolume } from './redux/playQueueSlice';
import multiSelectReducer from './redux/multiSelectSlice';
import configReducer from './redux/configSlice';
import MenuBuilder from './menu';
import { isWindows, isWindows10, isMacOS, isLinux } from './shared/utils';
import { settings, setDefaultSettings } from './components/shared/setDefaultSettings';

setDefaultSettings(false);

export const store = configureStore({
  reducer: {
    player: playerReducer,
    playQueue: playQueueReducer,
    multiSelect: multiSelectReducer,
    config: configReducer,
  },
  middleware: [triggerAlias, forwardToRenderer],
});

replayActionMain(store);

let mainWindow = null;
let tray = null;
let exitFromTray = false;
let forceQuit = false;
let saved = false;

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

if (process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true') {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS', 'REDUX_DEVTOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      { forceDownload, loadExtensionOptions: { allowFileAccess: true } }
    )
    .catch(console.log);
};

const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '../assets');

const getAssetPath = (...paths) => {
  return path.join(RESOURCES_PATH, ...paths);
};

const stop = () => {
  mainWindow.webContents.send('player-stop');
};

const pause = () => {
  mainWindow.webContents.send('player-pause');
};

const play = () => {
  mainWindow.webContents.send('player-play');
};

const playPause = () => {
  mainWindow.webContents.send('player-play-pause');
};

const nextTrack = () => {
  mainWindow.webContents.send('player-next-track');
};

const previousTrack = () => {
  mainWindow.webContents.send('player-prev-track');
};

const quickSave = () => {
  mainWindow.webContents.send('save-queue-state', app.getPath('userData'));
};

if (isLinux()) {
  const mprisPlayer = Player({
    name: 'Sonixd',
    identity: 'Sonixd',
    supportedUriSchemes: ['file'],
    supportedMimeTypes: ['audio/mpeg', 'application/ogg'],
    supportedInterfaces: ['player'],
    rate: 1.0,
    minimumRate: 1.0,
    maximumRate: 1.0,
  });

  mprisPlayer.on('quit', () => {
    process.exit();
  });

  mprisPlayer.on('stop', () => {
    stop();

    mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_STOPPED;
  });

  mprisPlayer.on('pause', () => {
    pause();

    if (mprisPlayer.playbackStatus === 'Playing') {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PAUSED;
    }

    const storeValues = store.getState();
    mainWindow.webContents.send('current-position-request', {
      currentPlayer: storeValues.playQueue.currentPlayer,
    });
  });

  mprisPlayer.on('play', () => {
    play();

    if (mprisPlayer.playbackStatus !== 'Playing') {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PLAYING;
    }

    const storeValues = store.getState();
    mainWindow.webContents.send('current-position-request', {
      currentPlayer: storeValues.playQueue.currentPlayer,
    });
  });

  mprisPlayer.on('playpause', () => {
    playPause();

    if (mprisPlayer.playbackStatus !== 'Playing') {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PLAYING;
    } else {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PAUSED;
    }

    const storeValues = store.getState();
    mainWindow.webContents.send('current-position-request', {
      currentPlayer: storeValues.playQueue.currentPlayer,
    });
  });

  mprisPlayer.on('next', () => {
    nextTrack();

    if (mprisPlayer.playbackStatus !== 'Playing') {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PLAYING;
    }
  });

  mprisPlayer.on('previous', () => {
    previousTrack();

    if (mprisPlayer.playbackStatus !== 'Playing') {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PLAYING;
    }
  });

  mprisPlayer.on('shuffle', () => {
    store.dispatch(toggleShuffle());
    settings.set('shuffle', !settings.get('shuffle'));
    mprisPlayer.shuffle = Boolean(settings.get('shuffle'));
  });

  mprisPlayer.on('volume', (event) => {
    const volume = Math.min(1, Math.max(0, event));
    store.dispatch(setVolume(volume));
    settings.set('volume', volume);
  });

  mprisPlayer.on('loopStatus', () => {
    const currentRepeat = settings.get('repeat');
    const newRepeat = currentRepeat === 'none' ? 'all' : currentRepeat === 'all' ? 'one' : 'none';
    store.dispatch(toggleRepeat());

    mprisPlayer.loopStatus =
      newRepeat === 'none' ? 'None' : newRepeat === 'all' ? 'Playlist' : 'Track';

    settings.set('repeat', newRepeat);
  });

  mprisPlayer.on('position', (event) => {
    const storeValues = store.getState();

    mainWindow.webContents.send('position-request', {
      position: event.position,
      currentPlayer: storeValues.playQueue.currentPlayer,
    });
  });

  mprisPlayer.on('seek', (event) => {
    const storeValues = store.getState();

    mainWindow.webContents.send('seek-request', {
      offset: event,
      currentPlayer: storeValues.playQueue.currentPlayer,
    });
  });

  ipcMain.on('playpause', (_event, arg) => {
    if (arg.status === 'PLAYING') {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PLAYING;
    } else {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PAUSED;
    }

    setTimeout(() => {
      mprisPlayer.seeked(arg.position);
    }, 100);
  });

  ipcMain.on('seeked', (_event, arg) => {
    // Send the position from Sonixd to MPRIS on manual seek
    setTimeout(() => {
      mprisPlayer.seeked(arg);
    }, 100);
  });

  ipcMain.on('current-song', (_event, arg) => {
    if (mprisPlayer.playbackStatus !== 'Playing') {
      mprisPlayer.playbackStatus = Player.PLAYBACK_STATUS_PLAYING;
    }

    mprisPlayer.metadata = {
      'mpris:trackid': arg?.id ? mprisPlayer.objectPath(`track/${arg?.id?.replace('-', '')}`) : '',
      'mpris:length': arg.duration ? Math.round((arg.duration || 0) * 1e6) : null,
      'mpris:artUrl': arg.image.includes('placeholder') ? null : arg.image,
      'xesam:title': arg.title || null,
      'xesam:album': arg.album || null,
      'xesam:artist': arg.artist?.length !== 0 ? arg.artist?.map((artist) => artist.title) : null,
      'xesam:albumArtist': arg.albumArtist ? arg.albumArtist : null,
      'xesam:discNumber': arg.discNumber ? arg.discNumber : null,
      'xesam:trackNumber': arg.track ? arg.track : null,
      'xesam:useCount': arg.playCount ? arg.playCount : null,
      'xesam:genre':
        arg.genre.filter((genre) => genre.title).length !== 0
          ? arg.genre.filter((genre) => genre.title).map((genre) => genre.title)
          : null,
    };
  });

  ipcMain.on('current-position', (e, arg) => {
    mprisPlayer.getPosition = () => arg * 1e6;
  });

  ipcMain.on('volume', (e, arg) => {
    mprisPlayer.volume = Number(arg);
  });
}

const createWinThumbarButtons = () => {
  if (isWindows()) {
    mainWindow.setThumbarButtons([
      {
        tooltip: 'Previous Track',
        icon: getAssetPath('skip-previous.png'),
        click: () => previousTrack(),
      },
      {
        tooltip: 'Play/Pause',
        icon: getAssetPath('play-circle.png'),
        click: () => playPause(),
      },
      {
        tooltip: 'Next Track',
        icon: getAssetPath('skip-next.png'),
        click: () => {
          nextTrack();
        },
      },
    ]);
  }
};

const saveQueue = (callback) => {
  ipcMain.on('saved-state', () => {
    callback();
  });

  mainWindow.webContents.send('save-queue-state', app.getPath('userData'));
};

const restoreQueue = () => {
  mainWindow.webContents.send('restore-queue-state', app.getPath('userData'));
};

const createWindow = async () => {
  if (process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true') {
    await installExtensions();
  }

  let windowDimensions = [];
  let windowPos = [];
  let isCentered = true;

  // If retained window size is enabled, use saved dimensions and position. Otherwise, use defined defaults
  if (settings.get('retainWindowSize')) {
    windowDimensions = settings.get('savedWindowSize');
    windowPos = settings.get('savedWindowPos');
    isCentered = false;
  } else {
    windowDimensions = [settings.get('defaultWindowWidth'), settings.get('defaultWindowHeight')];
  }

  mainWindow = new BrowserWindow({
    show: false,
    width: windowDimensions[0],
    height: windowDimensions[1],
    center: isCentered,
    x: windowPos[0],
    y: windowPos[1],
    icon: getAssetPath('icon.png'),
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
    minWidth: 768,
    minHeight: 600,
    frame: settings.get('titleBarStyle') === 'native',
  });

  electronLocalshortcut.register(mainWindow, 'Ctrl+Shift+I', () => {
    mainWindow?.webContents.openDevTools();
  });

  if (settings.get('globalMediaHotkeys')) {
    globalShortcut.register('MediaStop', () => {
      stop();
    });

    globalShortcut.register('MediaPlayPause', () => {
      playPause();
    });

    globalShortcut.register('MediaNextTrack', () => {
      nextTrack();
    });

    globalShortcut.register('MediaPreviousTrack', () => {
      previousTrack();
    });
  } else if (!settings.get('systemMediaTransportControls')) {
    electronLocalshortcut.register(mainWindow, 'MediaStop', () => {
      stop();
    });

    electronLocalshortcut.register(mainWindow, 'MediaPlayPause', () => {
      playPause();
    });

    electronLocalshortcut.register(mainWindow, 'MediaNextTrack', () => {
      nextTrack();
    });

    electronLocalshortcut.register(mainWindow, 'MediaPreviousTrack', () => {
      previousTrack();
    });
  }

  ipcMain.on('quicksave', () => {
    quickSave();
  });

  ipcMain.on('enableGlobalHotkeys', () => {
    electronLocalshortcut.unregisterAll(mainWindow);

    globalShortcut.register('MediaStop', () => {
      stop();
    });

    globalShortcut.register('MediaPlayPause', () => {
      playPause();
    });

    globalShortcut.register('MediaNextTrack', () => {
      nextTrack();
    });

    globalShortcut.register('MediaPreviousTrack', () => {
      previousTrack();
    });
  });

  ipcMain.on('disableGlobalHotkeys', () => {
    globalShortcut.unregisterAll();

    if (!settings.get('systemMediaTransportControls')) {
      electronLocalshortcut.register(mainWindow, 'MediaStop', () => {
        stop();
      });

      electronLocalshortcut.register(mainWindow, 'MediaPlayPause', () => {
        playPause();
      });

      electronLocalshortcut.register(mainWindow, 'MediaNextTrack', () => {
        nextTrack();
      });

      electronLocalshortcut.register(mainWindow, 'MediaPreviousTrack', () => {
        previousTrack();
      });
    }
  });

  mainWindow.loadURL(`file://${__dirname}/index.html#${settings.get('startPage')}`);

  // @TODO: Use 'ready-to-show' event
  // https://github.com/electron/electron/blob/master/docs/api/browser-window.md#using-ready-to-show-event
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
      mainWindow.focus();

      createWinThumbarButtons();
    }

    if (settings.get('resume')) {
      restoreQueue();
    }
  });

  mainWindow.on('minimize', (event) => {
    if (store.getState().config.window.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('moved', () => {
    if (settings.get('retainWindowSize')) {
      settings.set('savedWindowPos', mainWindow.getPosition());
    }
  });

  mainWindow.on('close', (event) => {
    if (!exitFromTray && store.getState().config.window.exitToTray) {
      if (isMacOS() && !forceQuit) {
        exitFromTray = true;
      }
      event.preventDefault();
      mainWindow.hide();
    }

    // If retain window size is enabled, save the dimensions
    if (settings.get('retainWindowSize')) {
      const curSize = mainWindow.getSize();
      settings.set('savedWindowSize', [curSize[0], curSize[1]]);
    }

    // If we have enabled saving the queue, we need to defer closing the main window until it has finished saving.
    if (!saved && settings.get('resume')) {
      event.preventDefault();
      saved = true;
      saveQueue(() => {
        mainWindow.close();
        if (forceQuit) {
          app.exit();
        }
      });
    }
  });

  if (isWindows()) {
    app.setAppUserModelId(process.execPath);
  }

  if (isMacOS()) {
    app.on('before-quit', () => {
      forceQuit = true;
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });

  // Remove this if your app does not use auto updates
  if (settings.get('autoUpdate') === true) {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-downloaded', () => {
      settings.set('autoUpdateNotice', true);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ipcMain.handle('file-path', async (_, argument) => {
    const filePath = dialog.showOpenDialogSync({
      properties: ['openFile', 'openDirectory'],
    });
    return filePath;
  });

  ipcMain.on('minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.on('maximize', () => {
    mainWindow.maximize();
  });

  ipcMain.on('unmaximize', () => {
    mainWindow.unmaximize();
  });

  ipcMain.on('close', () => {
    mainWindow.close();
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('maximize');
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('unmaximize');
  });
};

const createTray = () => {
  if (isMacOS()) {
    return;
  }

  tray = isLinux() ? new Tray(getAssetPath('icon.png')) : new Tray(getAssetPath('icon.ico'));
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Play/Pause',
      click: () => {
        playPause();
      },
    },
    {
      label: 'Next Track',
      click: () => {
        nextTrack();
      },
    },
    {
      label: 'Previous Track',
      click: () => {
        previousTrack();
      },
    },
    {
      label: 'Stop',
      click: () => {
        stop();
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Open main window',
      click: () => {
        mainWindow.show();
        createWinThumbarButtons();
      },
    },
    {
      label: 'Quit Sonixd',
      click: () => {
        exitFromTray = true;
        app.quit();
      },
    },
  ]);

  tray.on('double-click', () => {
    mainWindow.show();
    createWinThumbarButtons();
  });

  tray.setToolTip('Sonixd');
  tray.setContextMenu(contextMenu);
};

const gotProcessLock = app.requestSingleInstanceLock();
if (!gotProcessLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow.show();
  });
}

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  globalShortcut.unregisterAll();
  if (isMacOS()) {
    mainWindow = null;
  } else {
    app.quit();
  }
});

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

app
  .whenReady()
  .then(() => {
    createWindow();
    createTray();
    return null;
  })
  .catch(console.log);

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

ipcMain.on('reload', () => {
  if (process.env.APPIMAGE) {
    app.exit();
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: process.argv.slice(1).concat(['--appimage-extract-and-run']),
    });
    app.exit(0);
  } else {
    app.relaunch();
    app.exit();
  }
});
