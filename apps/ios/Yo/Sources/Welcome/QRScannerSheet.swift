import AVFoundation
import SwiftUI
import VisionKit

/// Scans the QR code of a phone link with VisionKit's live scanner.
struct QRScannerSheet: View {
    /// Gets each QR payload; the sheet closes when the app pairs.
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        NavigationStack {
            Group {
                if DataScannerViewController.isSupported && camera == .notDetermined {
                    ProgressView()
                } else if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    QRScanner(onCode: onCode)
                        .ignoresSafeArea(edges: .bottom)
                        .overlay(alignment: .bottom) { hint }
                } else {
                    ContentUnavailableView {
                        Label("Can't scan here", systemImage: "qrcode.viewfinder")
                    } description: {
                        Text(DataScannerViewController.isSupported
                            ? "Allow the camera for Yo in Settings, or paste the link instead."
                            : "This iPhone can't scan codes in Yo. Paste the link instead.")
                    }
                }
            }
            .task {
                guard DataScannerViewController.isSupported, camera == .notDetermined else { return }
                _ = await AVCaptureDevice.requestAccess(for: .video)
                camera = AVCaptureDevice.authorizationStatus(for: .video)
            }
            .navigationTitle("Scan your phone link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var hint: some View {
        Text(model.pairingError ?? "Point the camera at the QR code in Yo → Settings → Phone.")
            .font(.geist(15, .medium))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(20)
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var lastPayload: String?

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            for case let .barcode(code) in items {
                guard let payload = code.payloadStringValue, payload != lastPayload else { continue }
                lastPayload = payload
                onCode(payload)
                return
            }
        }
    }
}
