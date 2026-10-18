Model files go here. Run:   python scripts\fetch_models.py
  face_detection_yunet_2023mar.onnx   (MIT, OpenCV Zoo)       - better face detection + landmarks
  face_recognition_sface_2021dec.onnx (Apache-2.0, OpenCV Zoo) - optional reference matching
  face_landmarker.task                (Apache-2.0, Google)     - Observation lab offline
The app checks the SHA-256 of the ONNX files at start-up and refuses unknown files.
