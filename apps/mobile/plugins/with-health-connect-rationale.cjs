const { AndroidConfig, withAndroidManifest, withDangerousMod, withGradleProperties } = require('@expo/config-plugins');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const rationaleAction = 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE';
const activityName = '.HealthPermissionsRationaleActivity';

module.exports = function withHealthConnectRationale(config) {
  config = withGradleProperties(config, config => {
    const entry = config.modResults.find(item => item.type === 'property' && item.key === 'android.minSdkVersion');
    if (entry) {
      const current = Number(entry.value);
      if (!Number.isInteger(current)) throw new Error('Invalid Android minimum SDK');
      entry.value = String(Math.max(current, 26));
    } else {
      config.modResults.push({ type: 'property', key: 'android.minSdkVersion', value: '26' });
    }
    return config;
  });
  config = withAndroidManifest(config, config => {
    const manifest = config.modResults.manifest;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const main = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);
    main['intent-filter'] = (main['intent-filter'] || []).map(filter => ({
      ...filter, action: (filter.action || []).filter(action => action.$['android:name'] !== rationaleAction),
    })).filter(filter => filter.action.length);
    application.activity = (application.activity || []).filter(activity => activity.$['android:name'] !== activityName);
    application.activity.push({
      $: { 'android:name': activityName, 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': rationaleAction } }] }],
    });
    const alias = (application['activity-alias'] || []).find(item => item.$['android:name'] === 'ViewPermissionUsageActivity');
    if (!alias) throw new Error('Health Connect permission activity alias is missing');
    alias.$['android:targetActivity'] = activityName;
    manifest.queries ||= [];
    if (!manifest.queries.some(query => (query.package || []).some(item => item.$['android:name'] === 'com.google.android.apps.healthdata'))) {
      manifest.queries.push({ package: [{ $: { 'android:name': 'com.google.android.apps.healthdata' } }] });
    }
    return config;
  });

  return withDangerousMod(config, ['android', async config => {
    const packageName = config.android?.package;
    if (!packageName || !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(packageName)) throw new Error('Android package is required');
    const directory = path.join(config.modRequest.platformProjectRoot, 'app/src/main/java', ...packageName.split('.'));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'HealthPermissionsRationaleActivity.kt'), `package ${packageName}

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

class HealthPermissionsRationaleActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = "건강 데이터 안내"
    val padding = (24 * resources.displayMetrics.density).toInt()
    val text = TextView(this).apply {
      textSize = 16f
      setPadding(padding, padding, padding, padding)
      text = "삐꾸는 최근 7일의 걸음 수와 운동 기록을 기기에서 읽어 표시합니다. " +
        "건강 데이터는 이 기능에서만 사용하며 외부로 자동 전송하지 않습니다. " +
        "건강 데이터를 변경하지 않으며, Health Connect 설정에서 언제든 권한을 변경할 수 있습니다."
    }
    setContentView(ScrollView(this).apply { addView(text) })
  }
}
`);
    return config;
  }]);
};
