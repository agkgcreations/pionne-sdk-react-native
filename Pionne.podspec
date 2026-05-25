require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'Pionne'
  s.version        = package['version']
  s.summary        = 'Native crash capture (MetricKit) for the Pionne React Native SDK.'
  s.description    = 'Subscribes to MetricKit and replays native iOS crashes (Objective-C/Swift exceptions, signals, OOM) on the next launch.'
  s.license        = 'MIT'
  s.author         = 'AGKG Creations'
  s.homepage       = 'https://pionne.agkgcreations.fr'
  # ExpoModulesCore floor is iOS 13.4. MetricKit *crash* diagnostics need iOS
  # 14, so the Swift gates the subscription with `if #available(iOS 14.0, *)`.
  s.platforms      = { :ios => '13.4' }
  s.swift_version  = '5.4'
  s.source         = { :git => 'https://github.com/agkgcreations/pionne-sdk-react-native.git', :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
end
