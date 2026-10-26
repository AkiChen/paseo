package sh.paseo.gallery

import android.content.ContentValues
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class PaseoGalleryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoGallery")

    AsyncFunction("saveImageAsync") { fileUri: String, fileName: String ->
      val context = requireNotNull(appContext.reactContext) { "React context is unavailable" }
      val sourceUri = Uri.parse(fileUri)
      require(sourceUri.scheme == "file") { "Expected a local image file" }
      val source = File(requireNotNull(sourceUri.path)).canonicalFile
      val cacheRoot = context.cacheDir.canonicalFile
      require(source.path.startsWith(cacheRoot.path + File.separator)) { "Image must be in the app cache" }
      require(source.isFile && source.length() > 0) { "Image is empty or missing" }
      val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(source.path, options)
      val mimeType = requireNotNull(options.outMimeType) { "Unsupported image format for gallery" }
      require(options.outWidth > 0 && options.outHeight > 0) { "Invalid image" }
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, File(fileName).name)
        put(MediaStore.Images.Media.MIME_TYPE, mimeType)
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Paseo")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
      // minSdk is 29: inserting app-owned media needs no gallery-read permission.
      val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      val target = requireNotNull(resolver.insert(collection, values)) { "Could not create gallery image" }
      try {
        requireNotNull(resolver.openOutputStream(target, "w")).use { output ->
          source.inputStream().use { input -> input.copyTo(output) }
        }
        val published = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
        check(resolver.update(target, published, null, null) == 1) { "Could not publish gallery image" }
        target.toString()
      } catch (error: Exception) {
        try {
          resolver.delete(target, null, null)
        } catch (cleanupError: Exception) {
          error.addSuppressed(cleanupError)
        }
        throw error
      }
    }
  }
}
