(function () {
  function locate(geolocation = globalThis.navigator?.geolocation, secure = globalThis.isSecureContext) {
    if (!secure) return Promise.reject(new Error("定位需要 HTTPS 或 localhost；也可以手動選擇集合點。"));
    if (!geolocation) return Promise.reject(new Error("這個瀏覽器不支援定位，請改用手動選點。"));
    return new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(position => {
        const {latitude, longitude, accuracy} = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
          reject(new Error("裝置回傳的位置無效，請改用手動選點。"));
          return;
        }
        resolve({latitude: Math.round(latitude * 1000) / 1000, longitude: Math.round(longitude * 1000) / 1000,
          accuracy: Number.isFinite(accuracy) ? Math.max(0, Math.ceil(accuracy)) : null});
      }, error => {
        reject(new Error({1:"你未授權定位，仍可手動選點，不影響其他功能。",2:"裝置目前無法取得位置，請稍後重試或手動選點。",3:"定位等候逾時，請到訊號較好的地方重試，或手動選點。"}[error.code] || "定位失敗，請手動選點。"));
      }, {enableHighAccuracy: true, timeout: 12000, maximumAge: 60000});
    });
  }
  globalThis.MealLocation = {locate};
})();
