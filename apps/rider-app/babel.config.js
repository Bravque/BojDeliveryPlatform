// Expo's Metro bundler reads this for local dev / native builds (not used in CI).
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
