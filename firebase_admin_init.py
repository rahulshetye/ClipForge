import firebase_admin
from firebase_admin import credentials

cred = credentials.Certificate("clip-forge-8c199-firebase-adminsdk-fbsvc-9f3c225de0.json")

if not firebase_admin._apps:
    firebase_admin.initialize_app(cred)