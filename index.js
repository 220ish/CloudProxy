const os = require('os');
const path = require('path');
const fs = require('fs');
const { v1: uuidv1 } = require('uuid');
const log = require('console-log-level')(
  {
    level: process.env.LOG_LEVEL || 'info',
    prefix: function (level) {
      return new Date().toISOString() + " " + level.toUpperCase() + " REQ-" + reqCounter;
    }
  });


const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const http = require('http');
const pjson = require('./package.json');
const version = pjson.version;
const serverPort = process.env.PORT || 8191;
const serverHost = process.env.HOST || '0.0.0.0';
const logHtml = process.env.LOG_HTML || false;
const sessions = {}
let reqCounter = 0;

// setting "user-agent-override" evasion is not working for us because it can't be changed
// in each request. we set the user-agent in the browser args instead
puppeteer.use(StealthPlugin());

http.createServer(function (req, res) {
  reqCounter++;
  const startTimestamp = Date.now();
  log.info('Incoming request: ' + req.method + " " + req.url);
  let body = [];
  req.on('data', function (chunk) {
    body.push(chunk);
  }).on('end', function () {
    // parse params
    body = Buffer.concat(body).toString();
    var params = {};
    try {
      params = JSON.parse(body);
    }
    catch (err) {
      errorResponse("Body must be in JSON format", res, startTimestamp);
      return;
    }

    // validate params
    if (!validateIncomingRequest(params, req, res, startTimestamp))
      return;

    // process request
    processRequest(params, req, res, startTimestamp);
  });
}).listen(serverPort, serverHost, function () {
  log.info("FlareSolverr v" + version + " listening on http://" + serverHost + ":" + serverPort);
})

function errorResponse(errorMsg, res, startTimestamp) {
  log.error(errorMsg);
  const response = {
    status: "error",
    message: errorMsg,
    startTimestamp: startTimestamp,
    endTimestamp: Date.now(),
    version: version
  }
  res.writeHead(500, {
    'Content-Type': 'application/json'
  });
  res.write(JSON.stringify(response));
  res.end();
}

function successResponse(successMsg, extendedProperties, res, startTimestamp) {
  const endTimestamp = Date.now();
  log.info("Successful response in " + (endTimestamp - startTimestamp) / 1000 + " s");
  log.info(successMsg);

  const response = Object.assign(extendedProperties || {}, {
    status: "ok",
    message: successMsg,
    startTimestamp: startTimestamp,
    endTimestamp: endTimestamp,
    version: version
  })
  res.writeHead(200, {
    'Content-Type': 'application/json'
  });
  res.write(JSON.stringify(response));
  res.end();
}

function userDataDirFromSession(session) {
  return path.join(os.tmpdir(), '/puppeteer_firefox_profile_' + session);
}

function prepareBrowserProfile(userAgent, session) {
  const userDataDir = userDataDirFromSession(session);
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true })
  }
  const prefs = `user_pref("general.useragent.override", "${userAgent}");`;
  fs.writeFile(path.join(userDataDir, 'prefs.js'), prefs, () => { });
  return userDataDir;
}

function validateIncomingRequest(params, req, res, startTimestamp) {
  log.info('Params: ' + JSON.stringify(params));

  if (req.method != 'POST') {
    errorResponse("Only the POST method is allowed", res, startTimestamp);
    return false;
  }

  if (req.url != '/v1') {
    errorResponse("Only /v1 endpoint is allowed", res, startTimestamp);
    return false;
  }

  if (!params['cmd']) {
    errorResponse("Parameter 'cmd' is mandatory", res, startTimestamp);
    return false;
  }

  return true;
}

function processRequest(params, req, res, startTimestamp) {
  switch (params.cmd) {
    // EXPIRE
    case 'expire':
      if (sessions[params.session]) {
        sessions[params.session].close()
        delete sessions[params.session]
        fs.rmdirSync(userDataDirFromSession(params.session), { recursive: true })
        return successResponse('The session has been removed.', null, res, startTimestamp)
      }
      return errorResponse("This session does not exist.", res, startTimestamp);
    // GET
    case 'get':
      let puppeteerOptions = {
        product: 'firefox',
        headless: true
      };

      const session = params.session || uuidv1();
      const browser = sessions[session]

      const useBrowser = async browser => {
        try {
          await resolveCallenge(params, browser, res, startTimestamp, session);
        } catch (error) {
          console.error(error)
          errorResponse(error.message, res, startTimestamp);
        }
      }

      if (browser)
        return useBrowser(browser)

      const reqUserAgent = params["userAgent"];
      if (reqUserAgent) {
        log.debug('Using custom User-Agent: ' + reqUserAgent);
        // TODO: remove the profile after closing the browser
        puppeteerOptions['userDataDir'] = prepareBrowserProfile(reqUserAgent, session);
      }

      log.debug('Launching headless browser...');
      return puppeteer.launch(puppeteerOptions)
        .then(browser => {
          sessions[session] = browser
          useBrowser(browser)
        })
        .catch(error => {
          console.error(error)
          errorResponse(error.message, res, startTimestamp);
        });
    default:
      return errorResponse("The command '" + params.cmd + "' is invalid.", res, startTimestamp);
  }
}

async function resolveCallenge(params, browser, res, startTimestamp, session) {
  const page = await browser.newPage();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  log.debug("User-Agent: " + userAgent);
  const reqUrl = params["url"];
  const reqMaxTimeout = params["maxTimeout"] || 60000;
  const reqCookies = params["cookies"];

  if (reqCookies) {
    log.debug('Using custom cookies');
    await page.setCookie(...reqCookies);
  }

  log.debug("Navegating to... " + reqUrl);
  await page.goto(reqUrl, { waitUntil: 'domcontentloaded' });

  // detect cloudflare
  const cloudflareRay = await page.$('.ray_id');
  if (cloudflareRay) {
    log.debug('Waiting for Cloudflare challenge...');

    while (Date.now() - startTimestamp < reqMaxTimeout) {
      await page.waitFor(1000);

      try {
        // catch exception timeout in waitForNavigation
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 });
      } catch (error) { }

      const cloudflareRay = await page.$('.ray_id');
      if (!cloudflareRay)
        break;
    }

    if (Date.now() - startTimestamp >= reqMaxTimeout) {
      errorResponse("Maximum timeout reached. maxTimeout=" + reqMaxTimeout + " (ms)", res, startTimestamp);
      return;
    }

    log.debug("Validating HTML code...");
    const html = await page.content();
    if (html.includes("captcha-bypass") || html.includes("__cf_chl_captcha_tk__")) {
      errorResponse("Chaptcha detected!", res, startTimestamp);
      return;
    }
  } else {
    log.debug("No challenge detected");
  }

  const url = await page.url();
  log.debug("Response URL: " + url);
  const cookies = await page.cookies();
  log.debug("Response cookies: " + JSON.stringify(cookies));
  const html = await page.content();
  if (logHtml)
    log.debug(html);

  successResponse('', {
    session: session,
    solution: {
      url: url,
      response: html,
      cookies: cookies,
      userAgent: userAgent
    }
  }, res, startTimestamp)
}
