'use strict'

// Node Modules
const async = require('async')
const fs = require('fs')
const path = require('path')
const url = require('url')

// Third Party Modules
const _ = require('lodash')
const EventEmitter = require('eventemitter2').EventEmitter2
const electron = require('electron')
const uuid = require('uuid')

const setLogger = require('./logger').set
const WindowTailor = require('./windowTailor')
const WindowMaid = require('./windowMaid')
const wargs = require('./args')

// CONSTANTS

/** Interval for which to check for hung windows, in milliseconds */
const HUNG_WINDOW_CLEANUP_INTERVAL = process.env.ELECTRONPDF_WINDOW_CLEANUP_INTERVAL || 1000 * 30 /* seconds */

/** When a ready event option is set, this is the default timeout.  It is overridden by the wait option */
const MAX_READY_EVENT_WAIT = 10000
/** Amount of millis to wait before invoking WebContents.capturePage for PNG exports */
const PNG_CAPTURE_DELAY = process.env.ELECTRONPDF_PNG_CAPTURE_DELAY || 100
/** The event name for which Electron IPC is done over */
const IPC_MAIN_CHANNEL_RENDER = 'READY_TO_RENDER'
/** Prepended to events emitted during rendering */
const RENDER_EVENT_PREFIX = 'job.render.'

const DEFAULT_OPTIONS = {
  closeWindow: true,
  inMemory: false
}

// Use the maid to ensure we don't leak windows
setInterval(WindowMaid.cleanupHungWindows, HUNG_WINDOW_CLEANUP_INTERVAL)

const ipcMessagePromiseResolveFunctions = {}

if (electron.ipcMain) { // Not available or needed for tests
  electron.ipcMain.on('process-stats', (event, stats) => {
    const { messageId, windowId } = stats
    const job = WindowMaid.getCacheEntry(windowId).job
    const resolveFn = ipcMessagePromiseResolveFunctions[messageId]
    if (resolveFn) {
      job.debug(`resolving promise for messageId: ${messageId}`)
      resolveFn(stats)
      delete ipcMessagePromiseResolveFunctions[messageId]
    } else {
      job.info('no promise was found for process-stats message:', messageId)
    }
    job.info('renderer-process-stats', JSON.stringify(stats, undefined, 2))
  })
}

/**
 * A job should be created to process a given export opreation for one or more
 * resources and a set of output options.
 */
class ExportJob extends EventEmitter {
  /**
   *
   * @param {Array} input The path to the HTML or url, or a markdown file
   *   with 'md' or 'markdown' extension.
   *
   * @param output The name of the file to export to.  If the extension is
   *   '.png' then a PNG image will be generated instead of a PDF.
   *
   * @param {Object} args the minimist arg object; these args correlate to the CLI arguments
   *
   * @param {Object} options electron-pdf options that are only available
   *   when calling the ExportJob API programatically.
   *
   * @param {boolean} [options.closeWindow=true] If set to false, the window
   *   will not be closed when the job is complete.  This can be useful if you
   *   wish to reuse a window by passing it to the render function.
   *
   * @param {boolean} [options.inMemory=false] If set to true then `output`
   *   will be ignored and the results array will contain the Buffer object of the PDF
   *
   * @param {array} [options.orientations] must correlate to the input array and
   * contain a valid orientations ('landscape','portrait').  If not provided or
   *   length is not equal to source all orientations will be set to portrait
   *   unless the landscape arg was provided.
   *
   * @param {object} options.loggers inject your own logger functions which will
   * override the use of the visionmedia/debug default logger.  If you are using a
   * more sophisticated logger (i.e. Winston, etc) this allows you to get electron-pdf
   * logging that is timestamped and potentially includes context about your job.
   *
   * @param {Number} [options.windowLifespan=HUNG_WINDOW_THRESHOLD (5 minutes)] How long to allow a window to
   * remain open before it is forcefully closed (by windowMaid.js). In milliseconds.
   *
   * @param {Boolean} [options.reportRendererStats=false] Pass true to collect and
   * emit a `renderer-process-stats` event at key lifecycle stages (window open, page loaded, pdf generated)
   *
   * @param {Function} [options.fileSuffixFn] If provided, this function is invoked
   * with a numeric index (1 ... options.input.length) allowing the caller to manipulate
   * the file suffix in a custom way. (e.g. instead output_1.pdf, you could generate output_00001.pdf)
   *
   * @fires ExportJob#window.capture.end after each resource is captured (use
   *   this with inMemory)
   * @fires ExportJob#export-complete after each resource is available in
   *   memory or on the filesystem
   * @fires ExportJob#job-complete after all export resources are available on
   *   the filesystem
   */
  constructor (input, output, args, options) {
    super({
      // Allow listeners to provide wildcards
      wildcard: true,
      // displays the event name if maxListeners is reached for an event
      verboseMemoryLeak: true
    })
    this.jobId = uuid()
    this.input = _.isArray(input) ? input : [input]
    this.output = output
    this.args = args
    this.options = _.extend({}, DEFAULT_OPTIONS, options)

    const defaultOrientation = this.args.landscape ? 'landscape' : 'portrait'
    const validOrientation = _.size(this.options.orientations) === _.size(this.input)
    this.orientations = validOrientation
      ? this.options.orientations
      : _.fill(Array(_.size(this.input)), defaultOrientation)

    if (_.startsWith(this.args.pageSize, '{')) {
      this.args.pageSize = JSON.parse(this.args.pageSize)
    }

    setLogger(this.options.loggers, this)

    this.originalArgs = _.cloneDeep(this.args)
  }

  // ***************************************************************************
  // ************************* Public Functions ********************************
  // ***************************************************************************

  /**
   * Render markdown or html to pdf
   */
  render () {
    this.emit(`${RENDER_EVENT_PREFIX}start`)
    this._launchBrowserWindow()
    const win = this.window
    WindowMaid.registerOpenWindow(this)

    // TODO: Check for different domains, this is meant to support only a single origin
    const firstUrl = this.input[0]
    this._setSessionCookies(this.args.cookies, firstUrl, win.webContents.session.cookies)

    // The same listeners can be used for each resource
    this._passThroughEvents(win, RENDER_EVENT_PREFIX)

    this._load(win)
  }

  /**
   * If the html page requested emits a CustomEvent
   * (https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent/CustomEvent)
   * you may want to act upon the information it contains.
   *
   * Use this method to register your own observer.
   *
   * @param handler {Function<Promise>}
   *  A callback that is passed the following:
   *  - args[0]: the details object from CustomEvent
   *
   *  Can optionally fulfill the promise with an object
   *  that will be assigned to the context object for the current export.
   *
   *  Keys that are currently supported:
   *  {String} type - a valid export type, for example 'png' can be used to change
   *  the output from 'pdf' to a 'png' at runtime.
   *
   * @fires PDFExporter#window.observer.start when the observer is invoked
   * @fires PDFExporter#window.observer.timeout when the promise is not
   *   observed by the maximum wait time (default: 10 seconds).  The process
   *   will continue on and capture the page, it is up to the caller to handle
   *   this event accordingly.
   * @fires PDFExporter#window.observer.end when the observer fulfills the
   *   promise
   */
  observeReadyEvent (handler) {
    this.readyEventObserver = handler
  }

  /**
   * Change one of the arguments provided in the constructor.
   * Intended to be used with observeReadyEvent
   *
   * Note that electron-pdf uses the fully named arguments and none of the
   * aliases (i.e. 'landscape' and not 'l').  Even if you used an alias during
   * initialization make sure you pass the named argument here.
   *
   * @param arg The full name of the argument (i.e 'landscape')
   * @param value The new value
   */
  changeArgValue (arg, value) {
    this.args[arg] = value
  }

  /**
   * Invoke this method to ensure that any allocated resources are destroyed
   * Resources managed:
   * - this.window
   */
  destroy () {
    if (this.window) {
      try {
        this.info(`destroying job with window: ${this.window.id}`)
        WindowMaid.removeWindow(this.window.id)
        this.window.close()
      } finally {
        this.window = undefined
      }
    }
  }

  // ***************************************************************************
  // ************************* Private Functions *******************************
  // ***************************************************************************

  // Events
  /**
   * Listen for events and emit them from this job so clients can
   * do logging or event handling
   *
   * @param win
   * @param renderPrefix
   */
  _passThroughEvents (win, renderPrefix) {
    win.webContents.on('did-fail-load', (r) => {
      // http://electron.atom.io/docs/api/web-contents/#event-did-fail-load
      this.emit(`${renderPrefix}did-fail-load`, { results: r })
    })
    win.webContents.on('did-start-loading', (r) => {
      this.emit(`${renderPrefix}did-start-loading`, { results: r })
    })
    win.webContents.on('did-finish-load', (r) => {
      this.emit(`${renderPrefix}did-finish-load`, { results: r })
    })
    win.webContents.on('dom-ready', (r) => {
      this.emit(`${renderPrefix}dom-ready`, { results: r })
    })
    win.webContents.on('did-get-response-details',
      function (event,
        status,
        newURL,
        originalURL,
        httpResponseCode,
        requestMethod,
        referrer,
        headers,
        resourceType) {
        this.emit(`${renderPrefix}did-get-response-details`, {
          event: event,
          status: status,
          newURL: newURL,
          originalURL: originalURL,
          httpResponseCode: httpResponseCode,
          requestMethod: requestMethod,
          referrer: referrer,
          headers: headers,
          resourceType: resourceType
        })
      })
  }

  // Browser Setup

  /**
   *
   * @private
   */
  _initializeWindowForResource (landscape) {
    WindowMaid.touchWindow(this.window.id)
    // Reset the generated flag for each input URL because this same job/window
    // can be reused in this scenario
    this.generated = false

    // args can be modified by the client, restore them for each resource
    this.args = _.cloneDeep(this.originalArgs)
    const dim = WindowTailor.setWindowDimensions(this.window, this.args.pageSize, landscape)
    dim && this.emit('window.resize', dim)
  }

  /**
   *
   * @param {String} cookies - ';' delimited cookies, '=' delimited name/value
   *   pairs
   * @param {URL} requestedURL - URL Object
   * @param windowSessionCookies - The cookies object from the Electron
   *   window.session
   *
   * @private
   */
  _setSessionCookies (cookies, requestedURL, windowSessionCookies) {
    if (cookies) {
      const urlObj = url.parse(requestedURL)
      cookies.split(';').forEach(function (c) {
        const nameValue = c.split('=')
        const cookie = {
          url: urlObj.protocol + '//' + urlObj.host,
          name: nameValue[0],
          value: nameValue[1]
        }
        windowSessionCookies.set(cookie, function (err) {
          if (err) {
            this.error(err)
          }
        })
      })
    }
  }

  /**
   * Launch a browser window
   * @param args {Object} the minimist arg object
   * @returns {BrowserWindow}
   *
   * @private
   */
  _launchBrowserWindow () {
    const browserConfig = this._getBrowserConfiguration(this.args)
    this.emit('window.open.start', {})
    this.debug('Electron browserConfig:', JSON.stringify(browserConfig))
    let win = new electron.BrowserWindow(browserConfig)
    let browserWidth = parseInt(browserConfig.width);
    let browserHeight = parseInt(browserConfig.height);
    window.setSize(browserWidth, browserHeight);
    this.window = win
    this.emit('window.open.end', {
      width: browserWidth,
      height: browserHeight
    })

    win.on('closed', function () {
      win = null
    })
  }

  /**
   * see
   * http://electron.atom.io/docs/api/browser-window/#new-browserwindowoptions
   * @param args
   * @returns {Object} for BrowserWindow constructor
   * @private
   */
  _getBrowserConfiguration (args) {
    const pageDim = WindowTailor.getPageDimensions(args.pageSize, args.landscape)
    const trustRemoteContent = _.get(this.options, 'trustRemoteContent', false)

    const defaultOpts = {
      width: pageDim.x,
      height: pageDim.y,
      enableLargerThanScreen: true,
      show: false,
      center: true, // Display in center of screen,
      webPreferences: {
        nodeIntegration: trustRemoteContent,
        preload: path.join(__dirname, 'preload.js')
      }
    }

    // This creates a new session for every browser window, otherwise the same
    // default session is used from the main process which would break support
    // for concurrency
    // see http://electron.atom.io/docs/api/browser-window/#new-browserwindowoptions options.partition
    defaultOpts.webPreferences.partition = this.jobId

    let cmdLineBrowserConfig = {}
    try {
      cmdLineBrowserConfig = JSON.parse(args.browserConfig || '{}')
    } catch (e) {
      this.error('Invalid browserConfig provided, using defaults. Value:',
        args.browserConfig,
        '\nError:', e)
    }
    return _.extend(defaultOpts, cmdLineBrowserConfig)
  }

  /**
   * Define load options and load the URL in the window
   * @param window
   * @param url
   *
   * @private
   */
  _loadURL (window, url) {
    const loadOpts = {
      extraHeaders: _.join(this._getHeaders(), '\n')
    }

    // #249 - acceptLang doesn't work when set on extraHeaders anymore
    if (this.args.acceptLanguage) {
      const s = window.webContents.session
      s.setUserAgent(s.getUserAgent(), this.args.acceptLanguage)
    }

    const event = `${RENDER_EVENT_PREFIX}loadurl`
    this.emit(event, { url: url })
    this._triggerProcessStats(event)
    window.loadURL(wargs.urlWithArgs(url, null), loadOpts)
  }

  _getHeaders () {
    const headers = []
    this.args.disableCache && headers.push('pragma: no-cache')
    // Request headers to pass through
    if (this.args.requestHeaders) {
      _.each(JSON.parse(this.args.requestHeaders), (v, k) => headers.push(`${k}: ${v}`))
    }
    return headers
  }

  // Page Load & Rendering

  _load (win) {
    // Do not run printToPDF, useful if the page downloads a file that needs captured instead of a PDF
    // Currently only supports a single import url
    if (this.args.noprint) {
      // It's the responsibility of the window being loaded to initiate a download itself
      this._saveDownload(win)
    } else {
      this._renderAndCollectOutput(win, (context, outputDoneFn, observerContext) => {
        const ctx = _.extend({}, observerContext, context)
        const targetFile = this._getTargetFile(ctx)
        this._generateOutput(ctx, targetFile, outputDoneFn)
      })
    }
  }

  _saveDownload (win) {
    const downloadPromise = new Promise((resolve, reject) => {
      win.webContents.session.once('will-download', (event, item, webContents) => {
        // Set the save path, making Electron not to prompt a save dialog.
        item.setSavePath(this.output)
        item.once('done', (event, state) => resolve({ event, state }))
      })
    })

    this._renderAndCollectOutput(win, (context, outputDoneFn) => {
      downloadPromise.then(({ state }) => {
        if (state === 'completed') {
          this._emitResourceEvents(null, this.output, outputDoneFn)
        } else {
          this._emitResourceEvents(state, null, outputDoneFn)
        }
      })
    })
  }

  /**
   * Processes each of the url requests synchronously (in series)
   *
   * @param {Window} win The Window object
   * @param {Function} generateFunc
   * @private
   */
  _renderAndCollectOutput (win, generateFunc) {
    const windowEvents = []

    this.input.forEach((uriPath, inputIndex) => {
      const context = {
        uriPath,
        inputIndex,
        window: win
      }
      windowEvents.push((outputDoneFn) => this._captureWindow(context, generateFunc, outputDoneFn))
    })

    async.series(windowEvents, (err, results) => {
      if (this.options.closeWindow) {
        win.close()
        this.emit(`${RENDER_EVENT_PREFIX}window.close`)
      }
      /**
       * PDF Generation Event - fires when all PDFs have been persisted to disk
       * @event PDFExporter#job.complete
       * @type {object}
       * @property {String} results - array of generated pdf file locations
       * @property {Object} error - If an error occurred, null otherwise
       */
      this.emit(`${RENDER_EVENT_PREFIX}complete`, { results: results, error: err })
      this.emit('job-complete', { results: results, error: err }) // Deprecated
    })
  }

  /**
   * Loads a Uri and prepares the window for export based on the options provided.
   *
   * @param {Electron.BrowserWindow} context.window The browser window
   * @param {String} context.uriPath
   * @param {Number} context.inputIndex If multiple input uris are being generated, this is the index of the current one.
   * @param {Function} generateFn A callback that acts on a window ready to be captured.
   * @param {Function} outputDoneFn A call back invoked after generateFn has finished creating the output
   * @private
   */
  _captureWindow (context, generateFn, outputDoneFn) {
    const { window, uriPath } = context
    const orientation = this.orientations[context.inputIndex]
    this._initializeWindowForResource(orientation === 'landscape')
    const generateFunction = generateFn.bind(this, context, outputDoneFn)
    const waitFunction = this._waitForPage.bind(this, window, generateFunction, this.args.outputWait)
    window.webContents.once('did-finish-load', waitFunction)
    this._loadURL(window, uriPath)
  }

  /**
   * Injects a wait if defined before calling the generateFunction
   * Electron will apply the javascript we provide after the page is loaded,
   * we don't have to wire up event listeners
   * (https://github.com/electron/electron/pull/5319)
   *
   * @param window used for JavaScript injection to emit event back through IPC
   * @param generateFunction called when view is ready
   * @param waitTime wait time passed as an argument (if any), ignored when
   *   event is set
   *
   * @private
   */
  _waitForPage (window, generateFunction, waitTime) {
    const { noprint, waitForJSEvent } = this.args
    if (noprint) {
      // If the page isn't being captured don't wait at all
      // (e.g. A file download is initiated by the client using its own event listener)
      generateFunction()
    } else if (waitForJSEvent) {
      this._waitForBrowserEvent(waitForJSEvent, window, generateFunction)
    } else {
      setTimeout(generateFunction, waitTime)
    }
  }

  _waitForBrowserEvent (waitForJSEvent, window, generateFunction) {
    const eventName = _.size(waitForJSEvent) > 0 ? waitForJSEvent : 'view-ready'
    const ipcListener = this._attachIPCListener(eventName, generateFunction)
    this._executeJSListener(eventName, ipcListener, generateFunction, window)
  }

  /**
   * responsible for executing JS in the browser that will wait for the page
   * to emit an event before capturing the page.
   *
   * @param eventName
   * @param ipcListener The listener for the ready event.  This needs cancelled
   *   if there is a timeout before it the event is received
   * @param generateFunction
   * @param window
   * @private
   */
  _executeJSListener (eventName, ipcListener, generateFunction, window) {
    // event.detail will only exist if a CustomEvent was emitted
    const cmd = `document.body.addEventListener('${eventName}',
                   function(event) {
                     console.log('sending message over channel: ${IPC_MAIN_CHANNEL_RENDER}', '${this.jobId}', event.detail)
                     ipcApi.send('${IPC_MAIN_CHANNEL_RENDER}', '${this.jobId}', event.detail)
                     // #169 - allows clients to send event until we acknowledge receipt
                     document.body.dispatchEvent(new Event('${eventName}-acknowledged'))
                   }
                 )`

    // Don't let a ready event hang, set a max timeout interval
    const f = this._proceedWithExport.bind(this, eventName, ipcListener, generateFunction)
    const maxWait = this.getMaxWait()
    const timeout = setTimeout(f, maxWait)

    // clear the timeout as soon as we get the ready event from the browser
    this.once('window.event.wait.end', () => clearTimeout(timeout))
    // Or if the window was closed because it was hung for too long
    this.once('window.termination', () => clearTimeout(timeout))

    window.webContents.executeJavaScript(`window.ipcApi.initialize()`).then(() => {
      return window.webContents.executeJavaScript(cmd).catch(err => this.error(err))
    }).catch(err => this.error(err))
  }

  /**
   * How long to wait for content to be rendered in the browser window before capturing it's contents
   */
  getMaxWait () {
    const outputWait = this.args.outputWait || 0
    return outputWait > 0 ? outputWait : MAX_READY_EVENT_WAIT
  }

  /**
   * Invoked when a ready event has not been received before the max timeout is
   * reached
   * @param eventName The eventName provided by the client
   * @param ipcListener The ipcMain listener waiting for the
   *   IPC_MAIN_CHANNEL_RENDER event from the renderer process
   * @param generateFunction A callback function to invoke to capture the
   *   window
   * @private
   */
  _proceedWithExport (eventName, ipcListener, generateFunction) {
    this.emit('window.event.wait.timeout', { eventName: eventName })
    electron.ipcMain.removeListener(IPC_MAIN_CHANNEL_RENDER, ipcListener)
    generateFunction()
  }

  /**
   * Listen for the browser to emit the READY_TO_RENDER event and when it does
   * emit our own event so the max load timer is removed.
   *
   * @param eventName this is whatever the client provided
   * @param generateFunction _generateOutput with all of its arguments bound
   * @private
   */
  _attachIPCListener (eventName, generateFunction) {
    this.emit('window.event.wait.start', { eventName: eventName })
    const listener = (name, jobId, customEventDetail) => {
      // Multiple listeners could be active concurrently,
      // make sure we have the right event for this job
      // this.debug(`ready event received. this.jobId:${this.jobId}, event job id:${jobId}`)
      if (this.jobId === jobId) {
        this._triggerProcessStats('window.event.wait.end').then(() => {
          this.emit('window.event.wait.end', { eventName })
          if (this.readyEventObserver) {
            this._triggerReadyEventObserver(customEventDetail, generateFunction)
          } else {
            generateFunction()
          }
          electron.ipcMain.removeListener(IPC_MAIN_CHANNEL_RENDER, listener)
        })
      }
    }
    electron.ipcMain.on(IPC_MAIN_CHANNEL_RENDER, listener)
    return listener
  }

  /**
   * If an event observer was set it is invoked before the generateFunction.
   *
   * This function must ensure that the observer does not hang.
   *
   * @param customEventDetail detail from the DOMs CustomEvent
   * @param generateFunction callback function to capture the page
   * @private
   */
  _triggerReadyEventObserver (customEventDetail, generateFunction) {
    /**
     * fires right before a readyEventObserver is invoked
     * @event PDFExporter#window.observer.start
     * @type {object}
     * @property {String} detail - The CustomEvent detail
     */
    this.emit('window.observer.start', { detail: customEventDetail })

    const timeout = setTimeout(() => {
      /**
       * Fires when an observer times out
       * @event PDFExporter#window.observer.start
       * @type {object}
       */
      this.emit('window.observer.timeout', {})
      generateFunction()
    }, MAX_READY_EVENT_WAIT)

    this.readyEventObserver(customEventDetail).then(context => {
      /**
       * Fires when an observer fulfills its promise
       * @event PDFExporter#window.observer.end
       * @type {object}
       */
      this.emit('window.observer.end', {})
      clearTimeout(timeout)
      generateFunction(context)
    })
  }

  // Output

  _triggerProcessStats (event) {
    if (this.options.reportRendererStats) {
      const messageId = `${this.jobId}:${event}`
      this.debug(`invoking ipcApi.eventStats for messageId: ${messageId}`)

      // _.invoke used to accommodate testing
      _.invoke(this.window, 'webContents.executeJavaScript',
        `ipcApi.eventStats('${messageId}','${this.window.id}','${event}')`)

      return new Promise(resolve => {
        ipcMessagePromiseResolveFunctions[messageId] = resolve
      })
    } else {
      return Promise.resolve()
    }
  }

  /**
   * Create the PDF or PNG file.
   *
   * Because of timeouts and promises being resolved this function
   * is implemented to be idempotent
   *
   * @param context.window
   * @param context.type
   * @param outputFile
   * @param {Function} outputDoneFn callback that is invoked when the output file is complete (or errored)
   *
   * @private
   */
  _generateOutput (context, outputFile, outputDoneFn) {
    const { window } = context
    if (!this.generated) {
      this.generated = true
      // Multi-resource jobs can have different orientations, so resize the
      // window based on the orientations, which can be updated by the client
      // using changeArgValue
      const dim = WindowTailor.setWindowDimensions(this.window, this.args.pageSize, this.args.landscape)
      dim && this.emit('window.resize', dim)

      this.emit('window.capture.start', {})
      this._triggerProcessStats('window.capture.start').then(() => {
        if (outputFile.toLowerCase().endsWith('.png')) {
          this._captureImage(window, outputFile, outputDoneFn)
        } else if (outputFile.toLowerCase().endsWith('.html')) {
          this._captureHtml(window, outputFile, outputDoneFn)
        } else {
          this._capturePDF(this.args, window, outputDoneFn, outputFile)
        }
      })
    }
  }

  _captureHtml (window, outputFile, done) {
    window.webContents.executeJavaScript('document.documentElement.outerHTML', result => {
      const target = path.resolve(outputFile)
      fs.writeFile(target, result, function (err) {
        this._emitResourceEvents(err, target, done)
      }.bind(this))
    })
  }

  _captureImage (window, outputFile, outputDoneFn) {
    // We need a short timeout here or the image may not be captured fully
    // https://github.com/electron/electron/issues/6622
    setTimeout(() => {
      window.webContents.capturePage().then(image => {
        // http://electron.atom.io/docs/api/native-image/#imagetopng
        const pngBuffer = image.toPNG()
        if (this.options.inMemory) {
          this._emitResourceEvents(undefined, pngBuffer, outputDoneFn)
        } else {
          const target = path.resolve(outputFile)
          fs.writeFile(target, pngBuffer, function (err) {
            this._emitResourceEvents(err, target, outputDoneFn)
          }.bind(this))
        }
      })
    }, PNG_CAPTURE_DELAY)
  }

  _capturePDF (args, window, done, outputFile) {
    // TODO: Validate these because if they're wrong a non-obvious error will occur
    const pdfOptions = {
      marginsType: args.marginsType,
      printBackground: args.printBackground,
      printSelectionOnly: args.printSelectionOnly,
      pageSize: args.pageSize,
      landscape: args.landscape
    }
    this.debug(pdfOptions)
    try {
      window.webContents.printToPDF(pdfOptions)
        .then(data => {
          this.debug(`success printing PDF.`)
          this._triggerProcessStats('pdf.complete').then(() => {
            this._handlePDF(outputFile, done, undefined, data)
          })
        })
        .catch(error => {
          this.debug(`error printing PDF:`, error)
          this._triggerProcessStats('pdf.error').then(() => {
            this._handlePDF(outputFile, done, error, undefined)
          })
        })
        .finally(() => this.debug(`printToPDF has fulfilled it's promise`))
    } catch (e) {
      this.error(e)
    }
  }

  /**
   * The callback function for when printToPDF is complete
   * @param err
   * @param data
   * @private
   */
  _handlePDF (outputFile, done, err, data) {
    this._triggerProcessStats('window.capture.end').then(() => {
      if (this.options.inMemory || err) {
        this._emitResourceEvents(err, data, done)
      } else {
        const target = path.resolve(outputFile)
        fs.writeFile(target, data, (fileWriteErr) => {
          // REMOVE in 2.0 - keeping for backwards compatibility
          this.emit('pdf-complete', { file: target, error: fileWriteErr })
          this._emitResourceEvents(fileWriteErr, target, done)
        })
      }
    })
  }

  /**
   * Emits events when a resource has been captured or an error has occurred
   * while attempting the capture.
   *
   * @param err
   * @param data
   * @param outputDoneFn
   * @private
   */
  _emitResourceEvents (err, data, outputDoneFn) {
    /**
     * Window Event - fires when an export has captured the window (succesfully
     * or not)
     * @event PDFExporter#export-complete
     * @type {object}
     * @property {Buffer} data - The Buffer holding the PDF file
     * @property {Object} error - If an error occurred, undefined otherwise
     */
    this.emit('window.capture.end', { data: data, error: err })
    /**
     * Generation Event - fires when an export has be persisted to disk
     * @event PDFExporter#export-complete
     * @type {object}
     * @property {String} file - Path to the File
     */
    this.emit('export-complete', { data: data })
    outputDoneFn(err, data)
  }

  /**
   * @param {Number} context.inputIndex Index of the input being processed
   * @returns {String} the pdf output file name that should be used.
   * @private
   */
  _getTargetFile (context) {
    const zeroBasedIndex = context.inputIndex
    const ext = path.extname(this.output)
    const extIndex = this.output.lastIndexOf(ext)
    const actualExt = context.type === 'png' ? '.png' : ext
    if (_.size(this.input) > 1) {
      let suffix = `_${zeroBasedIndex + 1}`
      if (this.options.fileSuffixFn) {
        suffix = this.options.fileSuffixFn(zeroBasedIndex + 1)
      }
      return this.output.substring(0, extIndex) + `${suffix}${actualExt}`
    }
    return this.output.substring(0, extIndex) + actualExt
  }
}

module.exports = ExportJob
