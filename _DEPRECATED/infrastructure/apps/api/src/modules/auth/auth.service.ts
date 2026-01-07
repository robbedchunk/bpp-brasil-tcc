import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'

@Injectable()
export class AuthService {
  constructor (private readonly jwtService: JwtService) {}

  // Simple static user check for dev/demo
  async validateUser (username: string, password: string) {
    // Match exactly the same creds you use in Swagger
    if (username === 'admin' && password === 'admin') {
      return { userId: 1, username }
    }
    return null
  }

  async login (user: { userId: number; username: string }) {
    const payload = { username: user.username, sub: user.userId }
    return { access_token: this.jwtService.sign(payload) }
  }
}
