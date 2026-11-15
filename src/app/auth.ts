import { Injectable, inject, signal } from "@angular/core";
import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import{ catchError, throwError } from "rxjs";

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string | null){
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
    } catch {
        // ignore
    }
}

@Injectable({providedIn: 'root'})
export class AuthState {
    token = signal<string | null>(read(TOKEN_KEY));
    username = signal<string | null>(read(USER_KEY));

    login(token: string, username: string) {
        write(TOKEN_KEY, token);
        write(USER_KEY, username);
        this.token.set(token);
        this.username.set(username);
    }

    logout() {
        write(TOKEN_KEY, null);
        write(USER_KEY, null);
        this.token.set(null);
        this.username.set(null);
    }
}


export const authInterceptor: HttpInterceptorFn = (req, next) => {
    const auth = inject(AuthState);
    const token = auth.token();
    const request = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
    return next(request).pipe(
        catchError((err: HttpErrorResponse) => {
            if (err.status === 401 && token) {
                auth.logout();
            }   
            return throwError(() => err);
        })
    );
}