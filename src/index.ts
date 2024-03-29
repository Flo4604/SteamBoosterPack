import { existsSync, writeFileSync } from "fs";
import { EAuthTokenPlatformType, LoginSession } from "steam-session";
import { consola } from "consola";
import config from "../config.json";

const loginData = await login();

if (!loginData.cookies || !loginData.tokens) {
  consola.error("Failed to login Missing Tokens or Cookies");
  process.exit(1);
}

loginData.cookies.push(`timezoneOffset=${config.timezoneOffset},0`);

craftBoosterPacks();

if (config.recraftTime > 0) {
  setInterval(
    () => {
      craftBoosterPacks();
    },
    1000 * 60 * 60 * config.recraftTime,
  );
}

async function craftBoosterPacks() {
  const steamId = loginData.cookies
    .find((c) => c.startsWith("steamLoginSecure"))
    ?.split("%7C%7C")?.[0]
    .split("=")?.[1];

  const sessionId = loginData.cookies
    .find((c) => c.startsWith("sessionid"))
    ?.split("=")?.[1];

  const postHeaders = {
    Cookie: loginData.cookies.join(";"),
    Origin: "https://steamcommunity.com",
    Referer: "https://steamcommunity.com/tradingcards/boostercreator/",
    Host: "steamcommunity.com",
    UserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    ContentType: "application/x-www-form-urlencoded; charset=UTF-8",
  };

  const getHeaders = {
    Cookie: loginData.cookies.join(";"),
  };

  const boosterInfo = await fetch(
    "https://steamcommunity.com/tradingcards/boostercreator/",
    {
      headers: getHeaders,
    },
  );

  // Regular expression to match the array in the script tag
  const regex = /CBoosterCreatorPage\.Init\(.*?(\[[^\]].*\],)/gs;
  let body = await boosterInfo.text();
  body = body.replace(/[\r\n]+/g, "");
  const match = regex.exec(body);

  // Check if the match was found
  if (!match || !match[1]) {
    consola.error("App Booster Information not found or couldn't be parsed");
    process.exit(1);
  }

  const boosterApps = JSON.parse(match[1].replace(/,\s*$/, "")) as BoosterApp[];
  const boostList = (await import("../apps.json")).default;

  let appsToBoost = boosterApps.filter((app) => boostList.includes(app.appid));

  consola.info(
    `Found ${appsToBoost.length}/${boostList.length} apps to boost.`,
  );

  let i = 1;
  let gemsRemaining = 99999;
  for (const app of appsToBoost) {
    let logStart: string = `${app.name} (${app.appid}) - `;
    let logEnd: string = ` (${i++}/${appsToBoost.length})`;

    if (app?.unavailable === true) {
      consola.fail(
        logStart +
          `Skipping because it is unavailable until ${app.available_at_time}` +
          logEnd,
      );
      continue;
    }

    if (gemsRemaining - parseInt(app.price) < 0) {
      consola.info(
        logStart +
          `Skipping because we only have ${gemsRemaining} gems left` +
          logEnd,
      );
      continue;
    }

    const response = await fetch(
      "https://steamcommunity.com/tradingcards/ajaxcreatebooster/",
      {
        method: "POST",
        headers: postHeaders,
        // @ts-ignore
        body: new URLSearchParams({
          appid: `${app.appid}`,
          series: "1",
          tradability_preference: "2",
          sessionid: sessionId,
        }),
      },
    );

    if (!response.ok) {
      consola.error(
        logStart +
          `Failed to create boosterPack Response: ${await response.text()} | Status: ${response.status} ${response.statusText}` +
          logEnd,
      );

      continue;
    }

    const boosterData = (await response.json()) as CreateBoosterResponse;
    consola.success(
      logStart +
        `Created Booster with ID ${boosterData?.purchase_result?.communityitemid} [${boosterData.tradable_goo_amount}] Gems remaining` +
        logEnd,
    );

    if (!config.unpack) {
      continue;
    }

    const unpackResponse = await fetch(
      `https://steamcommunity.com/profiles/${steamId}/ajaxunpackbooster/`,
      {
        method: "POST",
        headers: postHeaders,
        // @ts-ignore
        body: new URLSearchParams({
          appid: app.appid,
          communityitemid: boosterData?.purchase_result?.communityitemid,
          sessionid: sessionId,
        }),
      },
    );

    const unpackData = (await unpackResponse.json()) as UnpackBoosterResponse;

    if (!unpackResponse.ok || !unpackData.success) {
      consola.error(
        logStart +
          `Failed to unpack boosterPack Response: ${await response.text()} | Status: ${response.status} ${response.statusText}` +
          logEnd,
      );

      continue;
    }

    const foils = unpackData.rgItems.filter((item) => item.foil);

    consola.success(
      logStart +
        `Unpacked Booster with ID ${boosterData?.purchase_result?.communityitemid} Got ${
          foils.length
            ? `(${foils.map((foil) => foil.name).join(", ")}`
            : foils.length
        } foils` +
        logEnd,
    );
  }

  return true;
}

async function login(): Promise<{
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
  cookies: string[];
}> {
  return new Promise(async (resolve) => {
    let session = new LoginSession(EAuthTokenPlatformType.MobileApp);
    if (existsSync("token.json")) {
      const currentData = require("../token.json");

      session.refreshToken = currentData.refreshToken;
      let renewed = await session.renewRefreshToken();

      if (renewed) {
        consola.debug(`New refresh token fetched`);
      } else {
        consola.debug("No new refresh token was issued");
      }

      return resolve(await writeSession(session));
    }

    session.loginTimeout = 120000;
    let startResult = await session.startWithQR();

    if (!startResult.qrChallengeUrl) {
      consola.error("ERROR: Failed to start QR login session!");
      return;
    }

    let qrUrl =
      "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" +
      encodeURIComponent(startResult.qrChallengeUrl);

    consola.info(`Open QR code: ${qrUrl}`);

    session.on("remoteInteraction", () => {
      consola.debug(
        "Looks like you've scanned the code! Now just approve the login.",
      );
    });

    session.on("authenticated", async () => {
      consola.success("\nAuthenticated successfully!");
      resolve(await writeSession(session));
    });

    session.on("timeout", () => {
      consola.error("This login attempt has timed out.");
    });

    session.on("error", (err) => {
      consola.error(`This login attempt has failed! ${err.message}`);
    });
  });
}

async function writeSession(session: LoginSession) {
  const data = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  };

  writeFileSync("token.json", JSON.stringify(data, null, 2));

  return { tokens: data, cookies: await session.getWebCookies() };
}

interface CreateBoosterResponse {
  purchase_result: PurchaseResult;
  goo_amount: string;
  tradable_goo_amount: string;
  untradable_goo_amount: number;
}

interface PurchaseResult {
  communityitemid: string;
  appid: number;
  item_type: number;
  purchaseid: string;
  success: number;
  rwgrsn: number;
}

interface UnpackBoosterResponse {
  success: number;
  rgItems: RgItem[];
}

export interface RgItem {
  image: string;
  name: string;
  series: number;
  foil: boolean;
}

export interface BoosterApp {
  appid: number;
  name: string;
  series: number;
  price: string;
  unavailable?: boolean;
  available_at_time?: string;
}
