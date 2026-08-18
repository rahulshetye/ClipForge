from fastapi import Header, HTTPException, status
from firebase_admin import auth as firebase_auth
import firebase_admin_init  # side-effect import, initializes the SDK

async def get_current_uid(authorization: str = Header(None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
        )

    id_token = authorization.split("Bearer ", 1)[1]

    try:
        decoded_token = firebase_auth.verify_id_token(id_token)
    except firebase_auth.ExpiredIdTokenError:
        raise HTTPException(status_code=401, detail="Token expired")
    except firebase_auth.InvalidIdTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception:
        raise HTTPException(status_code=401, detail="Token verification failed")

    return decoded_token["uid"]