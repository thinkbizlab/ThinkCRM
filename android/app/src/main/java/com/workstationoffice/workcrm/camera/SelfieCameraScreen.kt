package com.workstationoffice.workcrm.camera

import android.content.Context
import android.util.Log
import android.view.ViewGroup
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.SecondaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * CameraX-backed selfie capture surface. Front camera by default with a
 * Retake → Use Photo confirmation step. Hands the captured JPEG bytes to
 * `onCapture` exactly once; calls `onCancel` if the user taps Back.
 */
@androidx.compose.runtime.Composable
fun SelfieCameraScreen(
    onCapture: (ByteArray) -> Unit,
    onCancel: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor: ExecutorService = remember { Executors.newSingleThreadExecutor() }
    val imageCapture: MutableState<ImageCapture?> = remember { mutableStateOf(null) }
    var captured by remember { mutableStateOf<ByteArray?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    DisposableEffect(Unit) {
        onDispose { executor.shutdown() }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        if (captured == null) {
            AndroidView(
                factory = { ctx ->
                    val preview = PreviewView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    }
                    bindCamera(ctx, lifecycleOwner, preview, imageCapture)
                    preview
                },
                modifier = Modifier.fillMaxSize()
            )

            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(32.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                error?.let { Text(it, color = Tokens.danger) }
                PrimaryButton(text = "Capture") {
                    val capture = imageCapture.value ?: return@PrimaryButton
                    capture.takePicture(executor, object : ImageCapture.OnImageCapturedCallback() {
                        override fun onCaptureSuccess(image: androidx.camera.core.ImageProxy) {
                            val buffer = image.planes[0].buffer
                            val bytes = ByteArray(buffer.remaining())
                            buffer.get(bytes)
                            image.close()
                            captured = bytes
                        }
                        override fun onError(exception: ImageCaptureException) {
                            error = exception.message ?: "Capture failed"
                            Log.e("Selfie", "capture failed", exception)
                        }
                    })
                }
                SecondaryButton(text = "Cancel", onClick = onCancel)
            }
        } else {
            // Confirm / retake — we don't render the bytes as an Image yet to
            // keep the dependency surface minimal; just confirm or retake.
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("Photo captured (${(captured!!.size / 1024)} KB)", color = Tokens.textPrimary)
                PrimaryButton(text = "Use Photo", onClick = { captured?.let(onCapture) })
                SecondaryButton(text = "Retake", onClick = { captured = null })
            }
        }
    }
}

private fun bindCamera(
    context: Context,
    lifecycleOwner: androidx.lifecycle.LifecycleOwner,
    preview: PreviewView,
    imageCaptureSlot: MutableState<ImageCapture?>
) {
    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener({
        val cameraProvider = providerFuture.get()
        val previewUseCase = androidx.camera.core.Preview.Builder().build().also {
            it.setSurfaceProvider(preview.surfaceProvider)
        }
        val imageCapture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()
        val selector = CameraSelector.DEFAULT_FRONT_CAMERA
        try {
            cameraProvider.unbindAll()
            cameraProvider.bindToLifecycle(lifecycleOwner, selector, previewUseCase, imageCapture)
            imageCaptureSlot.value = imageCapture
        } catch (e: Exception) {
            Log.e("Selfie", "binding failed", e)
        }
    }, ContextCompat.getMainExecutor(context))
}
