/**
 * Environment for an actual LibreOffice conversion child.
 * On darwin, default SAL_USE_VCLPLUGIN=osx when the caller did not supply it.
 * Never mutates baseEnv (including process.env).
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {NodeJS.Platform} [platform]
 * @returns {NodeJS.ProcessEnv}
 */
export function libreOfficeChildEnv(baseEnv = process.env, platform = process.platform) {
  const env = { ...baseEnv };
  if (platform === "darwin" && !Object.hasOwn(baseEnv, "SAL_USE_VCLPLUGIN")) {
    env.SAL_USE_VCLPLUGIN = "osx";
  }
  return env;
}
