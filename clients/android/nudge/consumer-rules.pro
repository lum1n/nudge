# JNA and the generated bindings are reached by reflection.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class nudge.ffi.** { *; }
-dontwarn java.awt.**
