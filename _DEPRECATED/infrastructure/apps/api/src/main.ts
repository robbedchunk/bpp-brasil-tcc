import { AuthGuard } from '@nestjs/passport'
import { Reflector } from '@nestjs/core'
import { APP_GUARD } from '@nestjs/core'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { ValidationPipe } from '@nestjs/common'

async function bootstrap () {
  const app = await NestFactory.create(AppModule)

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))

  app.setGlobalPrefix('api')
  // Swagger Configuration
  const config = new DocumentBuilder()
    .setTitle('Prices Inflation API')
    .setDescription(
      'API documentation for price scraping and inflation tracking system',
    )
    .setVersion('1.0')
    .addTag('inflation')
    .build()

  const document = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup('docs', app, document)

  const port = process.env.PORT || 3000
  await app.listen(port)

  console.log(`Server running on http://localhost:${port}`)
  console.log(`Swagger docs available at http://localhost:${port}/docs`)
}
bootstrap()
