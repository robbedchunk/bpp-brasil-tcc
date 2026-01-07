import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScrapeRun } from '../../database/entities/scrape-run.entity';
import { CreateScrapeRunDto } from './dto/create-scrape-run.dto';
import { UpdateScrapeRunDto } from './dto/update-scrape-run.dto';

@Injectable()
export class ScrapeRunService {
  constructor(
    @InjectRepository(ScrapeRun)
    private readonly repo: Repository<ScrapeRun>,
  ) {}

  findAll() {
    return this.repo.find({ order: { startedAt: 'DESC' } });
  }

  async findOne(id: number) {
    const run = await this.repo.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`ScrapeRun #${id} not found`);
    return run;
  }

  create(data: CreateScrapeRunDto) {
    const run = this.repo.create({
      ...data,
      startedAt: new Date(),
    });
    return this.repo.save(run);
  }

  async update(id: number, data: UpdateScrapeRunDto) {
    const run = await this.findOne(id);
    Object.assign(run, data);
    return this.repo.save(run);
  }

  async finish(id: number) {
    const run = await this.findOne(id);
    run.status = 'finished';
    run.finishedAt = new Date();
    return this.repo.save(run);
  }

  async remove(id: number) {
    const run = await this.findOne(id);
    await this.repo.remove(run);
    return { deleted: true };
  }
}
