import _ from 'lodash';
import { BaseDriver, DeviceSettings } from 'appium/driver';
import {
  UiAutomator2Server, SERVER_PACKAGE_ID, SERVER_TEST_PACKAGE_ID
} from './uiautomator2';
import { fs, util, mjpeg } from 'appium/support';
import { retryInterval } from 'asyncbox';
import B from 'bluebird';
import commands from './commands/index';
import { DEFAULT_ADB_PORT } from 'appium-adb';
import uiautomator2Helpers from './helpers';
import {
  androidHelpers, androidCommands, SETTINGS_HELPER_PKG_ID
} from 'appium-android-driver';
import desiredCapConstraints from './desired-caps';
import { findAPortNotInUse, checkPortStatus } from 'portscanner';
import os from 'os';
import path from 'path';
import { APK_EXTENSION, APKS_EXTENSION } from './extensions';


const helpers = Object.assign({}, uiautomator2Helpers, androidHelpers);

// The range of ports we can use on the system for communicating to the
// UiAutomator2 HTTP server on the device
const DEVICE_PORT_RANGE = [8200, 8299];

// The guard is needed to avoid dynamic system port allocation conflicts for
// parallel driver sessions
const DEVICE_PORT_ALLOCATION_GUARD = util.getLockFileGuard(
  path.resolve(os.tmpdir(), 'uia2_device_port_guard'),
  {timeout: 25, tryRecovery: true}
);

// This is the port that UiAutomator2 listens to on the device. We will forward
// one of the ports above on the system to this port on the device.
const DEVICE_PORT = 6790;
// This is the port that the UiAutomator2 MJPEG server listens to on the device.
// We will forward one of the ports above on the system to this port on the
// device.
const MJPEG_SERVER_DEVICE_PORT = 7810;

const LOCALHOST_IP4 = '127.0.0.1';

// NO_PROXY contains the paths that we never want to proxy to UiAutomator2 server.
// TODO:  Add the list of paths that we never want to proxy to UiAutomator2 server.
// TODO: Need to segregate the paths better way using regular expressions wherever applicable.
// (Not segregating right away because more paths to be added in the NO_PROXY list)
const NO_PROXY = [
  ['GET', new RegExp('^/session/(?!.*/)')],
  ['GET', new RegExp('^/session/[^/]+/alert_[^/]+')],
  ['GET', new RegExp('^/session/[^/]+/alert/[^/]+')],
  ['GET', new RegExp('^/session/[^/]+/appium/[^/]+/current_activity')],
  ['GET', new RegExp('^/session/[^/]+/appium/[^/]+/current_package')],
  ['GET', new RegExp('^/session/[^/]+/appium/app/[^/]+')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/[^/]+')],
  ['GET', new RegExp('^/session/[^/]+/appium/settings')],
  ['GET', new RegExp('^/session/[^/]+/context')],
  ['GET', new RegExp('^/session/[^/]+/contexts')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/attribute')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/displayed')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/enabled')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/location_in_view')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/name')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/screenshot')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/selected')],
  ['GET', new RegExp('^/session/[^/]+/ime/[^/]+')],
  ['GET', new RegExp('^/session/[^/]+/location')],
  ['GET', new RegExp('^/session/[^/]+/network_connection')],
  ['GET', new RegExp('^/session/[^/]+/screenshot')],
  ['GET', new RegExp('^/session/[^/]+/timeouts')],
  ['GET', new RegExp('^/session/[^/]+/url')],
  ['POST', new RegExp('^/session/[^/]+/[^/]+_alert$')],
  ['POST', new RegExp('^/session/[^/]+/actions')],
  ['POST', new RegExp('^/session/[^/]+/alert/[^/]+')],
  ['POST', new RegExp('^/session/[^/]+/app/[^/]')],
  ['POST', new RegExp('^/session/[^/]+/appium/[^/]+/start_activity')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/[^/]+')],
  ['POST', new RegExp('^/session/[^/]+/appium/compare_images')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/(?!set_clipboard)[^/]+')],
  ['POST', new RegExp('^/session/[^/]+/appium/element/[^/]+/replace_value')],
  ['POST', new RegExp('^/session/[^/]+/appium/element/[^/]+/value')],
  ['POST', new RegExp('^/session/[^/]+/appium/getPerformanceData')],
  ['POST', new RegExp('^/session/[^/]+/appium/performanceData/types')],
  ['POST', new RegExp('^/session/[^/]+/appium/settings')],
  ['POST', new RegExp('^/session/[^/]+/appium/execute_driver')],
  ['POST', new RegExp('^/session/[^/]+/appium/start_recording_screen')],
  ['POST', new RegExp('^/session/[^/]+/appium/stop_recording_screen')],
  ['POST', new RegExp('^/session/[^/]+/appium/.*event')],
  ['POST', new RegExp('^/session/[^/]+/context')],
  ['POST', new RegExp('^/session/[^/]+/element')],
  ['POST', new RegExp('^/session/[^/]+/ime/[^/]+')],
  ['POST', new RegExp('^/session/[^/]+/keys')],
  ['POST', new RegExp('^/session/[^/]+/location')],
  ['POST', new RegExp('^/session/[^/]+/network_connection')],
  ['POST', new RegExp('^/session/[^/]+/timeouts')],
  ['POST', new RegExp('^/session/[^/]+/touch/multi/perform')],
  ['POST', new RegExp('^/session/[^/]+/touch/perform')],
  ['POST', new RegExp('^/session/[^/]+/url')],

  // MJSONWP commands
  ['GET', new RegExp('^/session/[^/]+/log/types')],
  ['POST', new RegExp('^/session/[^/]+/execute')],
  ['POST', new RegExp('^/session/[^/]+/execute_async')],
  ['POST', new RegExp('^/session/[^/]+/log')],
  // W3C commands
  // For Selenium v4 (W3C does not have this route)
  ['GET', new RegExp('^/session/[^/]+/se/log/types')],
  ['GET', new RegExp('^/session/[^/]+/window/rect')],
  ['POST', new RegExp('^/session/[^/]+/execute/async')],
  ['POST', new RegExp('^/session/[^/]+/execute/sync')],
  // For Selenium v4 (W3C does not have this route)
  ['POST', new RegExp('^/session/[^/]+/se/log')],
];

// This is a set of methods and paths that we never want to proxy to Chromedriver.
const CHROME_NO_PROXY = [
  ['GET', new RegExp('^/session/[^/]+/appium')],
  ['GET', new RegExp('^/session/[^/]+/context')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/rect')],
  ['GET', new RegExp('^/session/[^/]+/orientation')],
  ['POST', new RegExp('^/session/[^/]+/appium')],
  ['POST', new RegExp('^/session/[^/]+/context')],
  ['POST', new RegExp('^/session/[^/]+/orientation')],
  ['POST', new RegExp('^/session/[^/]+/touch/multi/perform')],
  ['POST', new RegExp('^/session/[^/]+/touch/perform')],

  // this is needed to make the mobile: commands working in web context
  ['POST', new RegExp('^/session/[^/]+/execute$')],
  ['POST', new RegExp('^/session/[^/]+/execute/sync')],

  // MJSONWP commands
  ['GET', new RegExp('^/session/[^/]+/log/types$')],
  ['POST', new RegExp('^/session/[^/]+/log$')],
  // W3C commands
  // For Selenium v4 (W3C does not have this route)
  ['GET', new RegExp('^/session/[^/]+/se/log/types$')],
  // For Selenium v4 (W3C does not have this route)
  ['POST', new RegExp('^/session/[^/]+/se/log$')],
];

const MEMOIZED_FUNCTIONS = [
  'getStatusBarHeight',
  'getDevicePixelRatio',
];

class AndroidUiautomator2Driver extends BaseDriver {
  constructor (opts = {}, shouldValidateCaps = true) {
    // `shell` overwrites adb.shell, so remove
    delete opts.shell;

    super(opts, shouldValidateCaps);
    this.locatorStrategies = [
      'xpath',
      'id',
      'class name',
      'accessibility id',
      'css selector',
      '-android uiautomator'
    ];
    this.desiredCapConstraints = desiredCapConstraints;
    this.uiautomator2 = null;
    this.jwpProxyActive = false;
    this.defaultIME = null;
    this.jwpProxyAvoid = NO_PROXY;
    this.apkStrings = {}; // map of language -> strings obj

    this.settings = new DeviceSettings({ignoreUnimportantViews: false, allowInvisibleElements: false},
        this.onSettingsUpdate.bind(this));
    // handle webview mechanics from AndroidDriver
    this.chromedriver = null;
    this.sessionChromedrivers = {};

    // memoize functions here, so that they are done on a per-instance basis
    for (const fn of MEMOIZED_FUNCTIONS) {
      this[fn] = _.memoize(this[fn]);
    }
  }

  validateDesiredCaps (caps) {
    return super.validateDesiredCaps(caps) && androidHelpers.validateDesiredCaps(caps);
  }

  async createSession (...args) {
    try {
      // TODO handle otherSessionData for multiple sessions
      let [sessionId, caps] = await super.createSession(...args);

      let serverDetails = {
        platform: 'LINUX',
        webStorageEnabled: false,
        takesScreenshot: true,
        javascriptEnabled: true,
        databaseEnabled: false,
        networkConnectionEnabled: true,
        locationContextEnabled: false,
        warnings: {},
        desired: this.caps,
      };

      this.caps = Object.assign(serverDetails, this.caps);

      this.curContext = this.defaultContextName();

      let defaultOpts = {
        fullReset: false,
        autoLaunch: true,
        adbPort: DEFAULT_ADB_PORT,
        androidInstallTimeout: 90000
      };
      _.defaults(this.opts, defaultOpts);

      if (this.isChromeSession) {
        this.log.info("We're going to run a Chrome-based session");
        let {pkg, activity} = helpers.getChromePkg(this.opts.browserName);
        this.opts.appPackage = this.caps.appPackage = pkg;
        this.opts.appActivity = this.caps.appActivity = activity;
        this.log.info(`Chrome-type package and activity are ${pkg} and ${activity}`);
      }

      if (this.opts.reboot) {
        this.setAvdFromCapabilities(caps);
      }

      if (this.opts.app) {
        // find and copy, or download and unzip an app url or path
        this.opts.app = await this.helpers.configureApp(this.opts.app, [APK_EXTENSION, APKS_EXTENSION]);
        await this.checkAppPresent();
      } else if (this.opts.appPackage) {
        // the app isn't an actual app file but rather something we want to
        // assume is on the device and just launch via the appPackage
        this.log.info(`Starting '${this.opts.appPackage}' directly on the device`);
      } else {
        this.log.info(`Neither 'app' nor 'appPackage' was set. Starting UiAutomator2 ` +
          'without the target application');
      }
      this.opts.adbPort = this.opts.adbPort || DEFAULT_ADB_PORT;

      await this.startUiAutomator2Session();
      await this.fillDeviceDetails();
      if (this.opts.mjpegScreenshotUrl) {
        this.log.info(`Starting MJPEG stream reading URL: '${this.opts.mjpegScreenshotUrl}'`);
        this.mjpegStream = new mjpeg.MJpegStream(this.opts.mjpegScreenshotUrl);
        await this.mjpegStream.start();
      }
      return [sessionId, this.caps];
    } catch (e) {
      await this.deleteSession();
      throw e;
    }
  }

  async fillDeviceDetails () {
    this.caps.pixelRatio = await this.getDevicePixelRatio();
    this.caps.statBarHeight = await this.getStatusBarHeight();
    this.caps.viewportRect = await this.getViewPortRect();
  }

  get driverData () {
    // TODO fill out resource info here
    return {};
  }

  async getSession () {
    let sessionData = await super.getSession();
    this.log.debug('Getting session details from server to mix in');
    let uia2Data = await this.uiautomator2.jwproxy.command('/', 'GET', {});
    return Object.assign({}, sessionData, uia2Data);
  }

  isEmulator () {
    return helpers.isEmulator(this.adb, this.opts);
  }

  setAvdFromCapabilities (caps) {
    if (this.opts.avd) {
      this.log.info('avd name defined, ignoring device name and platform version');
    } else {
      if (!caps.deviceName) {
        this.log.errorAndThrow('avd or deviceName should be specified when reboot option is enables');
      }
      if (!caps.platformVersion) {
        this.log.errorAndThrow('avd or platformVersion should be specified when reboot option is enabled');
      }
      let avdDevice = caps.deviceName.replace(/[^a-zA-Z0-9_.]/g, '-');
      this.opts.avd = `${avdDevice}__${caps.platformVersion}`;
    }
  }

  async allocateSystemPort () {
    const forwardPort = async (localPort) => {
      this.log.debug(`Forwarding UiAutomator2 Server port ${DEVICE_PORT} to local port ${localPort}`);
      if ((await checkPortStatus(localPort, LOCALHOST_IP4)) === 'open') {
        this.log.errorAndThrow(`UiAutomator2 Server cannot start because the local port #${localPort} is busy. ` +
          `Make sure the port you provide via 'systemPort' capability is not occupied. ` +
          `This situation might often be a result of an inaccurate sessions management, e.g. ` +
          `old automation sessions on the same device must always be closed before starting new ones.`);
      }
      await this.adb.forwardPort(localPort, DEVICE_PORT);
    };

    if (this.opts.systemPort) {
      this._hasSystemPortInCaps = true;
      return await forwardPort(this.opts.systemPort);
    }

    await DEVICE_PORT_ALLOCATION_GUARD(async () => {
      const [startPort, endPort] = DEVICE_PORT_RANGE;
      try {
        this.opts.systemPort = await findAPortNotInUse(startPort, endPort);
      } catch (e) {
        this.log.errorAndThrow(
          `Cannot find any free port in range ${startPort}..${endPort}}. ` +
          `Please set the available port number by providing the systemPort capability or ` +
          `double check the processes that are locking ports within this range and terminate ` +
          `these which are not needed anymore`);
      }
      await forwardPort(this.opts.systemPort);
    });
  }

  async releaseSystemPort () {
    if (!this.opts.systemPort || !this.adb) {
      return;
    }

    if (this._hasSystemPortInCaps) {
      await this.adb.removePortForward(this.opts.systemPort);
    } else {
      await DEVICE_PORT_ALLOCATION_GUARD(async () => await this.adb.removePortForward(this.opts.systemPort));
    }
  }

  async allocateMjpegServerPort () {
    if (this.opts.mjpegServerPort) {
      await this.adb.forwardPort(this.opts.mjpegServerPort, MJPEG_SERVER_DEVICE_PORT);
    }
  }

  async releaseMjpegServerPort () {
    if (this.opts.mjpegServerPort) {
      await this.adb.removePortForward(this.opts.mjpegServerPort);
    }
  }

  async startUiAutomator2Session () {
    // get device udid for this session
    let {udid, emPort} = await helpers.getDeviceInfoFromCaps(this.opts);
    this.opts.udid = udid;
    this.opts.emPort = emPort;

    // now that we know our java version and device info, we can create our
    // ADB instance
    this.adb = await androidHelpers.createADB(this.opts);

    const apiLevel = await this.adb.getApiLevel();

    if (apiLevel < 21) {
      this.log.errorAndThrow('UIAutomator2 is only supported since Android 5.0 (Lollipop). ' +
        'You could still use other supported backends in order to automate older Android versions.');
    }

    if (apiLevel >= 28) { // Android P
      this.log.info('Relaxing hidden api policy');
      await this.adb.setHiddenApiPolicy('1', !!this.opts.ignoreHiddenApiPolicyError);
    }

    // check if we have to enable/disable gps before running the application
    if (util.hasValue(this.opts.gpsEnabled)) {
      if (this.isEmulator()) {
        this.log.info(`Trying to ${this.opts.gpsEnabled ? 'enable' : 'disable'} gps location provider`);
        await this.adb.toggleGPSLocationProvider(this.opts.gpsEnabled);
      } else {
        this.log.warn(`Sorry! 'gpsEnabled' capability is only available for emulators`);
      }
    }

    // get appPackage et al from manifest if necessary
    const appInfo = await helpers.getLaunchInfo(this.adb, this.opts);
    // and get it onto our 'opts' object so we use it from now on
    Object.assign(this.opts, appInfo || {});

    // set actual device name, udid, platform version, screen size, screen density, model and manufacturer details
    this.caps.deviceName = this.adb.curDeviceId;
    this.caps.deviceUDID = this.opts.udid;

    // start an avd, set the language/locale, pick an emulator, etc...
    // TODO with multiple devices we'll need to parameterize this
    this.defaultIME = await helpers.initDevice(this.adb, this.opts);

    // Prepare the device by forwarding the UiAutomator2 port
    // This call mutates this.opts.systemPort if it is not set explicitly
    await this.allocateSystemPort();

    // Prepare the device by forwarding the UiAutomator2 MJPEG server port (if
    // applicable)
    await this.allocateMjpegServerPort();

    // set up the modified UiAutomator2 server etc
    await this.initUiAutomator2Server();

    // Should be after installing io.appium.settings in helpers.initDevice
    if (this.opts.disableWindowAnimation && (await this.adb.getApiLevel() < 26)) { // API level 26 is Android 8.0.
      // Granting android.permission.SET_ANIMATION_SCALE is necessary to handle animations under API level 26
      // Read https://github.com/appium/appium/pull/11640#issuecomment-438260477
      // `--no-window-animation` works over Android 8 to disable all of animations
      if (await this.adb.isAnimationOn()) {
        this.log.info('Disabling animation via io.appium.settings');
        await this.adb.setAnimationState(false);
        this._wasWindowAnimationDisabled = true;
      } else {
        this.log.info('Window animation is already disabled');
      }
    }

    // set up app under test
    // prepare our actual AUT, get it on the device, etc...
    await this.initAUT();

    // Adding AUT package name in the capabilities if package name not exist in caps
    if (!this.caps.appPackage && appInfo) {
      this.caps.appPackage = appInfo.appPackage;
    }

    // launch UiAutomator2 and wait till its online and we have a session
    await this.uiautomator2.startSession(this.caps);

    await this.addDeviceInfoToCaps();

    // Unlock the device after the session is started.
    if (!this.opts.skipUnlock) {
      // unlock the device to prepare it for testing
      await helpers.unlock(this, this.adb, this.caps);
    } else {
      this.log.debug(`'skipUnlock' capability set, so skipping device unlock`);
    }

    if (this.isChromeSession) { // start a chromedriver session
      await this.startChromeSession(this);
    } else if (this.opts.autoLaunch && this.opts.appPackage) {
      await this.ensureAppStarts();
    }

    // if the initial orientation is requested, set it
    if (util.hasValue(this.opts.orientation)) {
      this.log.debug(`Setting initial orientation to '${this.opts.orientation}'`);
      await this.setOrientation(this.opts.orientation);
    }

    // if we want to immediately get into a webview, set our context
    // appropriately
    if (this.opts.autoWebview) {
      const viewName = this.defaultWebviewName();
      const timeout = this.opts.autoWebviewTimeout || 2000;
      this.log.info(`Setting auto webview to context '${viewName}' with timeout ${timeout}ms`);
      await retryInterval(timeout / 500, 500, this.setContext.bind(this), viewName);
    }

    // now that everything has started successfully, turn on proxying so all
    // subsequent session requests go straight to/from uiautomator2
    this.jwpProxyActive = true;
  }

  async addDeviceInfoToCaps () {
    const {
      apiVersion,
      platformVersion,
      manufacturer,
      model,
      realDisplaySize,
      displayDensity,
    } = await this.mobileGetDeviceInfo();
    this.caps.deviceApiLevel = parseInt(apiVersion, 10);
    this.caps.platformVersion = platformVersion;
    this.caps.deviceScreenSize = realDisplaySize;
    this.caps.deviceScreenDensity = displayDensity;
    this.caps.deviceModel = model;
    this.caps.deviceManufacturer = manufacturer;
  }

  async initUiAutomator2Server () {
    // broken out for readability
    const uiautomator2Opts = {
      host: this.opts.remoteAdbHost || this.opts.host || LOCALHOST_IP4,
      systemPort: this.opts.systemPort,
      devicePort: DEVICE_PORT,
      adb: this.adb,
      apk: this.opts.app,
      tmpDir: this.opts.tmpDir,
      appPackage: this.opts.appPackage,
      appActivity: this.opts.appActivity,
      disableWindowAnimation: !!this.opts.disableWindowAnimation,
      disableSuppressAccessibilityService: this.opts.disableSuppressAccessibilityService,
      readTimeout: this.opts.uiautomator2ServerReadTimeout,
    };
    // now that we have package and activity, we can create an instance of
    // uiautomator2 with the appropriate options
    this.uiautomator2 = new UiAutomator2Server(this.log, uiautomator2Opts);
    this.proxyReqRes = this.uiautomator2.proxyReqRes.bind(this.uiautomator2);
    this.proxyCommand = this.uiautomator2.proxyCommand.bind(this.uiautomator2);

    if (this.opts.skipServerInstallation) {
      this.log.info(`'skipServerInstallation' is set. Skipping UIAutomator2 server installation.`);
    } else {
      await this.uiautomator2.installServerApk(this.opts.uiautomator2ServerInstallTimeout);
      try {
        await this.adb.addToDeviceIdleWhitelist(
          SETTINGS_HELPER_PKG_ID, SERVER_PACKAGE_ID, SERVER_TEST_PACKAGE_ID,
        );
      } catch (e) {
        this.log.warn(`Cannot add server packages to the Doze whitelist. Original error: ` +
          (e.stderr || e.message));
      }
    }
  }

  async initAUT () {
    // Uninstall any uninstallOtherPackages which were specified in caps
    if (this.opts.uninstallOtherPackages) {
      await helpers.uninstallOtherPackages(
        this.adb,
        helpers.parseArray(this.opts.uninstallOtherPackages),
        [SETTINGS_HELPER_PKG_ID, SERVER_PACKAGE_ID, SERVER_TEST_PACKAGE_ID]
      );
    }

    // Install any "otherApps" that were specified in caps
    if (this.opts.otherApps) {
      let otherApps;
      try {
        otherApps = helpers.parseArray(this.opts.otherApps);
      } catch (e) {
        this.log.errorAndThrow(`Could not parse "otherApps" capability: ${e.message}`);
      }
      otherApps = await B.all(otherApps
        .map((app) => this.helpers.configureApp(app, [APK_EXTENSION, APKS_EXTENSION])));
      await helpers.installOtherApks(otherApps, this.adb, this.opts);
    }

    if (this.opts.app) {
      if (this.opts.noReset && !(await this.adb.isAppInstalled(this.opts.appPackage))
          || !this.opts.noReset) {
        if (!this.opts.noSign && !await this.adb.checkApkCert(this.opts.app, this.opts.appPackage, {
          requireDefaultCert: false,
        })) {
          await helpers.signApp(this.adb, this.opts.app);
        }
        if (!this.opts.skipUninstall) {
          await this.adb.uninstallApk(this.opts.appPackage);
        }
        await helpers.installApk(this.adb, this.opts);
      } else {
        this.log.debug('noReset has been requested and the app is already installed. Doing nothing');
      }
    } else {
      if (this.opts.fullReset) {
        this.log.errorAndThrow('Full reset requires an app capability, use fastReset if app is not provided');
      }
      this.log.debug('No app capability. Assuming it is already on the device');
      if (this.opts.fastReset && this.opts.appPackage) {
        await helpers.resetApp(this.adb, this.opts);
      }
    }
  }

  async ensureAppStarts () {
    // make sure we have an activity and package to wait for
    const appWaitPackage = this.opts.appWaitPackage || this.opts.appPackage;
    const appWaitActivity = this.opts.appWaitActivity || this.opts.appActivity;

    this.log.info(`Starting '${this.opts.appPackage}/${this.opts.appActivity} ` +
      `and waiting for '${appWaitPackage}/${appWaitActivity}'`);

    if (this.caps.androidCoverage) {
      this.log.info(`androidCoverage is configured. ` +
        ` Starting instrumentation of '${this.caps.androidCoverage}'...`);
      await this.adb.androidCoverage(this.caps.androidCoverage, appWaitPackage, appWaitActivity);
    } else {
      await this.adb.startApp({
        pkg: this.opts.appPackage,
        activity: this.opts.appActivity,
        action: this.opts.intentAction || 'android.intent.action.MAIN',
        category: this.opts.intentCategory || 'android.intent.category.LAUNCHER',
        flags: this.opts.intentFlags || '0x10200000', // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
        waitPkg: this.opts.appWaitPackage,
        waitActivity: this.opts.appWaitActivity,
        waitForLaunch: this.opts.appWaitForLaunch,
        waitDuration: this.opts.appWaitDuration,
        optionalIntentArguments: this.opts.optionalIntentArguments,
        stopApp: !this.opts.dontStopAppOnReset,
        retry: true,
        user: this.opts.userProfile,
      });
    }

  }

  async deleteSession () {
    this.log.debug('Deleting UiAutomator2 session');

    const screenRecordingStopTasks = [async () => {
      if (!_.isEmpty(this._screenRecordingProperties)) {
        await this.stopRecordingScreen();
      }
    }, async () => {
      if (await this.mobileIsMediaProjectionRecordingRunning()) {
        await this.mobileStopMediaProjectionRecording();
      }
    }, async () => {
      if (!_.isEmpty(this._screenStreamingProps)) {
        await this.mobileStopScreenStreaming();
      }
    }];

    await androidHelpers.removeAllSessionWebSocketHandlers(this.server, this.sessionId);

    if (this.uiautomator2) {
      try {
        await this.stopChromedriverProxies();
      } catch (err) {
        this.log.warn(`Unable to stop ChromeDriver proxies: ${err.message}`);
      }
      if (this.jwpProxyActive) {
        try {
          await this.uiautomator2.deleteSession();
        } catch (err) {
          this.log.warn(`Unable to proxy deleteSession to UiAutomator2: ${err.message}`);
        }
      }
      this.uiautomator2 = null;
    }
    this.jwpProxyActive = false;

    if (this.adb) {
      await B.all(screenRecordingStopTasks.map((task) => {
        (async () => {
          try {
            await task();
          } catch (ign) {}
        })();
      }));

      if (this.opts.unicodeKeyboard && this.opts.resetKeyboard && this.defaultIME) {
        this.log.debug(`Resetting IME to '${this.defaultIME}'`);
        try {
          await this.adb.setIME(this.defaultIME);
        } catch (err) {
          this.log.warn(`Unable to reset IME: ${err.message}`);
        }
      }
      if (this.caps.androidCoverage) {
        this.log.info('Shutting down the adb process of instrumentation...');
        await this.adb.endAndroidCoverage();
        // Use this broadcast intent to notify it's time to dump coverage to file
        if (this.caps.androidCoverageEndIntent) {
          this.log.info(`Sending intent broadcast '${this.caps.androidCoverageEndIntent}' at the end of instrumenting.`);
          await this.adb.broadcast(this.caps.androidCoverageEndIntent);
        } else {
          this.log.warn('No androidCoverageEndIntent is configured in caps. Possibly you cannot get coverage file.');
        }
      }
      if (this.opts.appPackage) {
        if (!this.isChromeSession
            && !this.opts.dontStopAppOnReset
            && !this.opts.noReset) {
          try {
            await this.adb.forceStop(this.opts.appPackage);
          } catch (err) {
            this.log.warn(`Unable to force stop app: ${err.message}`);
          }
        }
        if (this.opts.fullReset && !this.opts.skipUninstall) {
          this.log.debug(`Capability 'fullReset' set to 'true', Uninstalling '${this.opts.appPackage}'`);
          try {
            await this.adb.uninstallApk(this.opts.appPackage);
          } catch (err) {
            this.log.warn(`Unable to uninstall app: ${err.message}`);
          }
        }
      }
      // This value can be true if test target device is <= 26
      if (this._wasWindowAnimationDisabled) {
        this.log.info('Restoring window animation state');
        await this.adb.setAnimationState(true);
      }
      await this.adb.stopLogcat();
      try {
        await this.releaseSystemPort();
      } catch (error) {
        this.log.warn(`Unable to remove system port forward: ${error.message}`);
        // Ignore, this block will also be called when we fall in catch block
        // and before even port forward.
      }
      try {
        await this.releaseMjpegServerPort();
      } catch (error) {
        this.log.warn(`Unable to remove MJPEG server port forward: ${error.message}`);
        // Ignore, this block will also be called when we fall in catch block
        // and before even port forward.
      }

      if (await this.adb.getApiLevel() >= 28) { // Android P
        this.log.info('Restoring hidden api policy to the device default configuration');
        await this.adb.setDefaultHiddenApiPolicy(!!this.opts.ignoreHiddenApiPolicyError);
      }

      if (this.opts.reboot) {
        let avdName = this.opts.avd.replace('@', '');
        this.log.debug(`Closing emulator '${avdName}'`);
        try {
          await this.adb.killEmulator(avdName);
        } catch (err) {
          this.log.warn(`Unable to close emulator: ${err.message}`);
        }
      }
    }
    if (this.mjpegStream) {
      this.log.info('Closing MJPEG stream');
      this.mjpegStream.stop();
    }
    await super.deleteSession();
  }

  async checkAppPresent () {
    this.log.debug('Checking whether app is actually present');
    if (!(await fs.exists(this.opts.app))) {
      this.log.errorAndThrow(`Could not find app apk at '${this.opts.app}'`);
    }
  }

  async onSettingsUpdate () {
    // intentionally do nothing here, since commands.updateSettings proxies
    // settings to the uiauto2 server already
  }

  // Need to override android-driver's version of this since we don't actually
  // have a bootstrap; instead we just restart adb and re-forward the UiAutomator2
  // port
  async wrapBootstrapDisconnect (wrapped) {
    await wrapped();
    await this.adb.restart();
    await this.allocateSystemPort();
    await this.allocateMjpegServerPort();
  }

  proxyActive (sessionId) {
    super.proxyActive(sessionId);

    // we always have an active proxy to the UiAutomator2 server
    return true;
  }

  canProxy (sessionId) {
    super.canProxy(sessionId);

    // we can always proxy to the uiautomator2 server
    return true;
  }

  getProxyAvoidList (sessionId) {
    super.getProxyAvoidList(sessionId);
    // we are maintaining two sets of NO_PROXY lists, one for chromedriver(CHROME_NO_PROXY)
    // and one for uiautomator2(NO_PROXY), based on current context will return related NO_PROXY list
    if (util.hasValue(this.chromedriver)) {
      // if the current context is webview(chromedriver), then return CHROME_NO_PROXY list
      this.jwpProxyAvoid = CHROME_NO_PROXY;
    } else {
      this.jwpProxyAvoid = NO_PROXY;
    }
    if (this.opts.nativeWebScreenshot) {
      this.jwpProxyAvoid = [...this.jwpProxyAvoid, ['GET', new RegExp('^/session/[^/]+/screenshot')]];
    }

    return this.jwpProxyAvoid;
  }

  get isChromeSession () {
    return helpers.isChromeBrowser(this.opts.browserName);
  }
}

// first add the android-driver commands which we will fall back to
for (let [cmd, fn] of _.toPairs(androidCommands)) {
  AndroidUiautomator2Driver.prototype[cmd] = fn;
}

// then overwrite with any uiautomator2-specific commands
for (let [cmd, fn] of _.toPairs(commands)) {
  AndroidUiautomator2Driver.prototype[cmd] = fn;
}

export { AndroidUiautomator2Driver };
export default AndroidUiautomator2Driver;
