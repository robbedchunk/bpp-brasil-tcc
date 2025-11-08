import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCountryToProxy1736201234567 implements MigrationInterface {
  name = 'AddCountryToProxy1736201234567'

  public async up (queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "proxy" ADD COLUMN "country" CHAR(2);`)
    await queryRunner.query(
      `ALTER TABLE proxy ADD CONSTRAINT proxy_ip_port_unique UNIQUE (ip, port);`,
    )
  }

  public async down (queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "proxy" DROP COLUMN "country"`)
  }
}
