# Excluding `flutter_tts` from Windows builds

When a Flutter app does not need text-to-speech on Windows, avoid installing Windows toolchain dependencies just to satisfy plugin linking. Instead, exclude `flutter_tts` from Windows.

## Recommended architecture

1. Ensure only one implementation file imports `flutter_tts` directly (for example, `voice_mobile.dart`).
2. Use a conditional-export facade:

```dart
export 'voice_stub.dart'
  if (dart.library.io) 'voice_mobile.dart';
```

3. Keep the stub plugin-free:

```dart
class VoiceIO {
  Future<void> init() async {}
  Future<void> speak(String text) async {}
  Future<String?> listen({Duration max = const Duration(seconds: 4)}) async => null;
  bool get available => false;
}
```

4. Guard initialization/use sites:

```dart
if (_voice.available) {
  await _voice.init();
}
```

5. Restrict plugin platforms in `pubspec.yaml` so Flutter does not register it for Windows:

```yaml
flutter_tts:
  platforms:
    android:
    ios:
```

6. Refresh generated state:

```bash
flutter clean
flutter pub get
flutter run -d windows
```

## Temporary workaround (not durable)

You can edit `windows/flutter/generated_plugins.cmake` and remove `flutter_tts`, but this file is regenerated and should not be the long-term fix.


## One-command automation

Use the codemod helper to apply the `pubspec.yaml` platform restriction automatically in a Flutter project:

```bash
python scripts/apply_flutter_tts_windows_fix.py --project-root /path/to/flutter_app
```

For CI/check mode:

```bash
python scripts/apply_flutter_tts_windows_fix.py --project-root /path/to/flutter_app --check
```
